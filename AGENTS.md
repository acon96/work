# AGENTS.md — guidelines for developing `work`

This document is for AI agents (and humans) doing further development on this repository.

## General Behavior
1. Do not use special symbols or non-standard Unicode characters because they can cause encoding issues. Prefer ASCII character art such as `->`, `...`, or `--`.
2. When commenting code, only add comments that are necessary to explain the **current state** of the code. Do NOT explain the change being made, the prior state of the code, the regression or bug being fixed, or the reason for the change. Those belong in the commit message, not in the code comments.
3. Do not unnecessarily wrap lines of code or documentation files. Code should be wrapped at a logical spot in the line, and documentation should only use newlines for line breaks between paragraphs or sections. Markdown handles paragraph wrapping automatically, so do not add newlines in the middle of paragraphs.

---

## Repository layout

> Note: Do NOT update this layout unless there are actual structural changes to the repo. It causes unnecessary churn in this file.

```
work/
|-- .pi/               Pi agent and web state
|   |-- agent/         Agent settings and sessions
|   |   \-- sessions/  Persistent session data
|   |-- scheduled/     Scheduler state and run history
|   \-- web/           Pi Web state
|-- config/            Runtime and service configuration
|-- scripts/           Container and scheduler scripts
|-- extensions/        Pi agent extensions
|-- skills/            Pi agent skills
|-- pi-web-plugins/    Pi Web plugin overrides
\-- .github/
    \-- workflows/    CI/CD workflows
```

---

## Core invariants — never violate these

1. **There is only one runtime user: `agent` (uid 1001), and the agent container runs as it.** `USER agent` is set in the image and `user: "1001:1001"` in Compose. There is no sudo, no gosu, no root entrypoint, and no `CAP_*` on the agent container.
2. **The Pi Web UI port is published on the host loopback only.** The `work` service maps `${PI_WEB_BIND_ADDRESS:-127.0.0.1}:${PI_WEB_PORT:-8504}:8504`. Never widen `PI_WEB_BIND_ADDRESS`: pi-web is not a permission boundary; pi-permission-system and pi-sandbox enforce policy.
3. **Network and Bash policy is enforced by pi-sandbox, not by infrastructure.** The policy JSON files under `config/` ship baked into the image (runtime paths under `~/.pi/agent/`, pristine root-owned copies under `/etc/work/policies/`); there are deliberately NO policy file mounts in Compose or the Kubernetes Deployment. The entrypoint re-renders the runtime configs from the pristine copies at startup, and the only runtime policy knobs are env vars merged in at that point: `PROXY_ALLOWLIST` (comma-separated domains appended to `network.allowedDomains`) and `SSRF_ALLOW_RANGES` (comma-separated CIDRs appended to pi-web-access `ssrf.allowRanges`). Anything beyond those two knobs means editing `config/` and rebuilding the image. `network.allowedDomains` is the silent baseline and the real policy: pi-sandbox starts its runtime with no per-connection approval callback, so an unmatched destination is denied, and the only prompt is a static scan of the command text for URLs it names (see "Adding an allowlisted domain"). Squid, the MITM CA, and the separate proxy container were removed deliberately in favor of per-Bash-command bubblewrap enforcement; do not reintroduce them half-way.
4. **Tool/file policy is enforced by pi-permission-system.** `config/pi-permission-system-config.json` (installed at `~/.pi/agent/extensions/pi-permission-system/config.json`, read-only) configures human prompts only: no `authorizerChain`, so no model-backed reviewer ever runs. Keep `external_directory: ask` and the secret-file `deny` block.
5. **The sandbox substrate must be verified, not assumed.** The container healthcheck runs a bubblewrap probe with the same procfs binding the wrapper requests (`--bind /proc /proc`); if user namespaces, seccomp, or AppArmor on the node block it, the stack reports unhealthy rather than running unenforced. Requirements: usable unprivileged user namespaces (on AppArmor-enforcing nodes: an unconfined pod AppArmor profile or a bwrap profile, plus `kernel.apparmor_restrict_unprivileged_userns=0`) and a permissive-enough seccomp profile (`seccompProfile: Unconfined` on Kubernetes). No capabilities are granted and the agent stays uid 1001: `config/sandbox.json` sets `enableWeakerNestedSandbox`, which is what makes procfs work inside an unprivileged container.
6. **Session data persists via bind mounts** at `/home/agent/.pi/agent/sessions` (from `.pi/agent/sessions`), `/home/agent/.pi/agent/settings.json` (from `.pi/agent/settings.json`), and `/home/agent/.pi/web` (from `.pi/web`). Never hardcode paths to non-persistent locations.

---

## Extending extensions

All extensions live in `extensions/<name>/index.ts` and implement `ExtensionAPI` from `@earendil-works/pi-coding-agent`.

### Adding a new tool

```typescript
pi.registerTool({
  name: "my-tool",
  description: "...",
  parameters: Type.Object({ ... }),  // Use TypeBox
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // ...
    return { content: [{ type: "text", text: "..." }], details: {} };
  },
});
```

### Persisting state across sessions

```typescript
// Write
pi.appendEntry<MyState>("my-state-type", { ... });

// Read on session_start / session_tree
for (const entry of ctx.sessionManager.getBranch()) {
  if (entry.type === "custom" && entry.customType === "my-state-type") {
    // restore state from entry.data
  }
}
```

### Intercepting tool calls

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return undefined;
  // Return { block: true, reason: "..." } to deny, or undefined to allow.
});
```

### Executing shell commands

Use `pi.exec("bash", ["-c", command])` which returns `{ stdout, stderr, code, killed }`.

### pi-superagent extension

The `pi-superagent` extension inverts the traditional agent hierarchy: instead of a strong model driving weak subagents, the weak model gathers all context and sends it to a strong model ONCE for strategic planning.

**Cost optimization strategy:**
- Local model: gathers context via read/bash (free)
- Strong model: receives complete context, generates plan (single API call)
- Local model: executes plan (free)

**Configuration:**
- Fully dynamic - no environment variables needed
- Uses pi's existing provider/model configuration (via `pi login`)
- Model is specified per-invocation in tool parameters

**Usage:** The local model calls the `superagent_plan` tool with:
- `provider` — provider name (e.g., "anthropic", "openai", "openrouter")
- `model` — model ID (e.g., "claude-sonnet-4-20250514", "o1", "gpt-4o")
- `userQuery` — the task that needs planning
- `planContextToolCallIds` — array of tool call IDs from previous `read`/`bash`/`grep`/`find` calls to include as context
- `fileContents` — array of file paths to read and include as context (alternative to tool call IDs)
- `additionalContext` — optional extra context
- `maxContextBytes` — optional context budget (default: 100000, min: 10000, max: 500000)

The strong model receives all gathered context in a single prompt and returns a structured plan. The local model then executes the plan step-by-step.

**Slash commands:**
- `/superagent models` — list all available models for planning
- `/superagent providers` — list configured providers and auth status

**Why this works:**
- Local agent models are excellent at following instructions but poor at planning
- Cloud reasoning models are excellent at planning but expensive per token
- Single strong-model call eliminates multi-turn cache-read costs
- 60-80% cost reduction vs. traditional strong-model-drives-all workflows

See `extensions/superagent/README.md` for full documentation.

---

## pi web plugins

Custom pi-web plugins live in `pi-web-plugins/<id>/` and are written in TypeScript (with a `tsconfig.json`) or plain JavaScript. During the Docker build, `scripts/build-plugins.sh` compiles any TypeScript plugins to JavaScript and copies the output into the pi-web plugins directory inside `node_modules`. Bundled plugins to replace are specified via the `PI_WEB_REPLACE_PLUGINS` env var (space-separated).

The `scheduler-history` plugin reads execution logs from `/home/agent/.pi/scheduled/`, which is outside the workspace. Access to this directory is granted via `pathAccess.allowedPaths` in the pi-web config at `config/pi-web-config.json` (installed to `/home/agent/.config/pi-web/config.json` at build time).

Relays are deliberately disabled: pi-web's session daemon auto-installs the `@jmfederico/pi-relay` package (shipped inside its tarball at `dist/pi-packages/relays`) into the agent profile at startup. The Dockerfile deletes that shipped source, and `scripts/entrypoint.sh` seeds the matching pi-web dismissal record in `$PI_WEB_DATA_DIR` so reconciliation skips it. Keep both: do not re-add a `relays` entry to `packages` in settings.json.

---

## Docker & sandboxing

### Topology

| Network       | Egress? | Attached to                              |
|---------------|---------|------------------------------------------|
| `agent-net`   | yes (subnet pinned to 172.28.0.0/24) | `work`, `searxng` (static IP 172.28.0.10), `llama-swap` |

Squid and the separate proxy container are gone. Network policy for Bash is enforced per-command inside `work` by pi-sandbox (bubblewrap network namespaces + policy broker). The Pi process itself and the pi-sandbox broker use `agent-net` directly; sandboxed Bash commands get a private namespace whose only exit is the broker's policy proxy.

The `agent-net` subnet is pinned so the SearXNG address in `config/web-search.json` -> `ssrf.allowRanges` stays stable; update both together when deploying (e.g. Kubernetes pod IP for SearXNG).

### Runtime requirements for pi-sandbox

- `bubblewrap`, `socat`, `ripgrep` installed in the image (see Dockerfile).
- Unprivileged user namespaces usable inside the container: keep `seccomp:unconfined` (Kubernetes: `seccompProfile.type: Unconfined`), and on AppArmor-enforcing nodes set the pod to `appArmorProfile.type: Unconfined` (or install a bwrap profile) plus `kernel.apparmor_restrict_unprivileged_userns=0` on the node.
- No capabilities, no root: the container keeps `cap_drop: ALL`, `no-new-privileges`, and uid 1001. bubblewrap 0.8 rejects every privileged route for a non-root caller (setuid removed upstream; it dies outright when a non-zero uid holds capabilities), so capabilities are not an option here.
- Procfs inside the sandbox comes from `enableWeakerNestedSandbox: true` in `config/sandbox.json`: an unprivileged container refuses the fresh procfs remount (`bwrap: Can't mount proc on /newroot/proc: Operation not permitted`), so every sandboxed command would fail without it. Weaker mode binds the container's `/proc` into each sandbox instead of mounting a fresh one: sandboxed Bash can see the container's process table, which is why the outer container boundary matters.
- The container healthcheck probes `bwrap` with the matching procfs mode, so a node that breaks sandboxing shows up as unhealthy rather than silently unenforced.

### Filesystem scope inside the sandbox

`config/sandbox.json` is the whole story, and its shape is deliberate:

- `allowWrite: [".", "/scratch"]` -- `.` is expanded per session against that session's CWD, so writes are confined to the project the session is working in plus scratch. Do not widen this to `/workspace`: that would let one session write into another project's tree.
- `allowRead: ["/**"]` with a short `denyRead` list (`~/.pi/agent/auth.json`, `~/.git-credentials`, `~/.ssh`). Reads are open on purpose: the agent researches inside the container. `denyRead` beats `allowRead`, and it is what protects the provider credentials from *sandboxed Bash*; the Pi process itself is not sandboxed, so those same paths are also denied in the pi-permission-system `path` map for the native file tools.
- `denyWrite` entries must all already exist. Bubblewrap needs a real mount point for a denied path; for a missing one it creates an empty stub file in the parent directory (the `.pi/extensions/pi-sandbox` ghost in the old build). The fork cleans these up, but do not rely on that: deny paths that exist. `.pi/sandbox.json` is the one relative entry and is verified not to leave a stub.
- `denyMandatoryCwdFiles: false` keeps pi-sandbox from masking `.gitconfig`, `.bashrc`, `.mcp.json` and friends in the working directory, which would show up as zero-length char devices in the user's tree.
- `/scratch` is a memory-backed volume in both Compose (tmpfs) and Kubernetes (`emptyDir: { medium: Memory }`), and the image directory is `1777` so a foreign uid can still write. `$TMPDIR` is writable but per-command; anything that must survive to the next command belongs in `/scratch`.

### Two extensions are named pi-sandbox

This image uses `pi-sandbox` (carderne/pi-sandbox, config at `~/.pi/agent/sandbox.json`, project override `<cwd>/.pi/sandbox.json`). It is a different package from `@erichll/pi-sandbox` (config at `~/.pi/agent/extensions/pi-sandbox/config.json`), which this repo used before: different config schema, different path, different prompt semantics, and no nested-container knob. Docs and issues for one do not describe the other; check `package.json` before trusting anything written about "pi-sandbox".

- `npm install` needs `--legacy-peer-deps` (both installs in the Dockerfile): pi-sandbox publishes `peerOptional @earendil-works/pi-coding-agent@^0.80.0`, which conflicts with the 1.x agent this image pins. The conflict is stale published metadata -- the package's imports resolve fine against 1.x -- so keep the flag until upstream widens the range rather than downgrading the agent.

### Never patch node modules

There is no `patches/` directory and there must not be one. The former `pi-sandbox-weaker-nested.patch` existed only because the package then in use exposed no knob for nested-container procfs; the package used now exposes `enableWeakerNestedSandbox` in its own config, and the build has no patch step. If a future dependency seems to need a patch, look for the config option first (read its schema, not just its README) and prefer switching packages over patching: a patched `node_modules` tree is invisible to `npm install`, silently diverges from the lockfile, and re-breaks on every version bump.

### Adding an allowlisted domain

Two ways:

1. **Command-text prompt (interactive only):** before running a Bash command, pi-sandbox scans its text for `http(s)://host` URLs and prompts the human once for any host outside `network.allowedDomains` ("always allow" appends the domain to `~/.pi/agent/sandbox.json`). This is a static scan, not a connection-level gate: a host reached through a redirect, a bare IP literal, or a config file is never detected, and the proxy then drops the connection with no prompt. Sessions without UI (scheduler tasks) cannot prompt, so nothing is approved there.
2. **Permanent baseline:** set `PROXY_ALLOWLIST` (comma-separated domains) in the deployment environment. The entrypoint merges those domains into the baked `network.allowedDomains` at startup (see Core invariant 3); apply by restarting the container/pod. Entries are exact domains and strict-subdomain wildcards (`*.example.com` -- this does NOT match the apex domain). For durable base changes, edit `config/sandbox.json` and rebuild the image.

Because the prompt cannot be relied on for correctness, treat `network.allowedDomains` as the real policy: anything a scheduled or long-running task needs must be in the baseline. The proxy resolves hostnames for the sandbox and never resolves internal service names on the deployment network in a useful way for Bash, so `searxng` and `llama-swap` are reached through Pi's own tools (web_search, model providers), which run outside the Bash jail. If a Bash command genuinely needs an internal service, that is a design decision to make explicitly, not an allowlist edit.

### Changing policy (operator only)

Policy is baked into the image under `/home/agent/.pi/agent/` (`sandbox.json`, `web-search.json`) and `/home/agent/.pi/agent/extensions/` (pi-permission-system) -- no policy file mounts. The only operator runtime knobs are the `PROXY_ALLOWLIST` and `SSRF_ALLOW_RANGES` env vars (see Core invariant 3). There is deliberately no agent-side control path (no tool, no slash command, no script in the agent image); do not add one back.

The network decision chain for a sandboxed command is: command-text scan (prompt only for URLs the command actually names) -> static deny -> static allow -> deny. `config/sandbox.json` already sets `strictAllowlist: true`; it makes no difference here, because pi-sandbox starts the runtime without a per-connection approval callback and denies anything unmatched on its own.

Writes follow the same "no unsatisfiable prompt" rule: pi-sandbox's write-block prompt only reacts to `Operation not permitted`, but bubblewrap mounted the rest of the filesystem read-only, so an outside write fails with `Read-only file system` and no prompt is offered. Do not add writable paths on the assumption that a human gets asked first -- they will not be.

### Containment checks

Run these after any topology, image, or policy change. Container-level checks run via `docker compose exec`, i.e. OUTSIDE a Pi Bash tool call, so they do not exercise the bubblewrap wrapper; the sandbox probes must be run from inside a Pi session's Bash tool.

Container-level checks (run from outside, they test the container, not a sandbox):

```bash
# expected to succeed from the Pi process (egress exists for the container)
docker compose exec work curl -sS -o /dev/null -w '%{http_code}\n' https://api.anthropic.com/

# expected: uid 1001, no sudo, no capabilities (weaker nested sandbox mode is
# what makes procfs work without them)
docker compose exec work sh -c 'id -u; command -v sudo || echo "no sudo"; grep -E "^Cap(Bnd|Prm):" /proc/self/status'

# expected: healthcheck goes UNHEALTHY if bwrap cannot sandbox
docker compose exec work healthcheck
```

Sandbox checks -- these must run **inside a Pi session's Bash tool**, since that is the only place the bubblewrap wrapper applies. Expected results with the shipped `config/sandbox.json`:

```
touch ./ok                      -> ok (the session CWD is writable)
touch /scratch/ok               -> ok  (stable scratch; verify with ls -l /scratch)
touch /scratch/ok then read it  -> ok  in a LATER command (scratch persists per container)
touch /workspace/other/x        -> denied (Read-only file system) when not in the CWD
touch /tmp/x                    -> denied; echo x > "$TMPDIR/x" -> ok but command-local
touch /etc/x                    -> denied
cat ~/.pi/agent/auth.json       -> denied (masked by denyRead)
cat /etc/passwd                 -> ok  (reads are open for research)
curl -sS -o /dev/null -w '%{http_code}' https://pypi.org/simple/ -> 200
curl -sS -o /dev/null -w '%{http_code}' https://example.com/     -> failure (000), no prompt
echo x >> ~/.pi/agent/sandbox.json -> denied (policy is read-only inside the sandbox)
mkdir -p .pi && echo '{}' > .pi/sandbox.json -> denied (no self-relaxing via project config)
```

Passing these in Compose demonstrates the data path. It is **not** evidence that Kubernetes NetworkPolicy works; the cluster needs the same checks re-run.

---

## pi extension configuration

### Source of truth for what is loaded

- `package.json` → `pi.extensions` and `pi.skills` defines what Pi loads.
- `extensions/` and `skills/` can contain additional local items that are not loaded until listed in `package.json`.

Current `package.json` includes:

- Extensions: `system-prompt`, `scheduler`, `todo`, `llama-swap`, `superagent`, `chat-titles`.
- Skills: `notify`, `superagent`. `wiki-js`

### package.json

All off-the-shelf pi extensions are declared as `dependencies` with pinned versions.  The `pi` key declares local extension paths for the gallery.

### .pi/agent/settings.json

This file is bind-mounted into the container at `/home/agent/.pi/agent/settings.json`. It configures:
- `defaultProvider` / `defaultModel`: default model for sessions
- `compaction`: context compaction settings (reserve tokens, keep recent tokens)
- `retry`: retry settings for failed requests
- `extensions`: paths to local extension directories (e.g., `/home/agent/.pi/extensions`)
- `packages`: npm packages to load resources from (pinned versions)

### .pi/agent/models.json

This file is bind-mounted into the container at `/home/agent/.pi/agent/models.json`.  It configures:
- `providers`: custom provider configurations
- `llama-swap`: llama-swap base URL, API key, and field mapping from llama-swap metadata to pi model properties. The `slotCache` boolean here enables per-session KV cache stashing and stable llama.cpp slot assignment. To override it at runtime (e.g. to disable slot persistence for one-shot/automated runs), use the `LLAMA_SWAP_SLOT_CACHE` env var (`on`/`off`); it wins over this config value. `scripts/scheduler-run.sh` exports it as `off` by default so scheduled tasks never churn llama-swap's slot endpoints.

### SearXNG

The SearXNG endpoint is configured via the `SEARXNG_BASE_URL` env var, read at runtime by the `pi-web-access` extension (`web_search` tool). Search providers are pinned to SearXNG via `config/web-search.json` -> `webSearch.allowedProviders`; the SSRF guard's `ssrf.allowRanges` must cover the SearXNG address for it to be reachable.

---

## Pi Web

Pi Web is a web control plane for Pi Coding Agent with a split-process architecture:
- **Session daemon** (`pi-web-sessiond`): owns active Pi session runtimes, listens on Unix socket at `~/.pi-web/sessiond.sock`
- **Web server** (`pi-web-server`): serves the API and browser UI, defaults to `127.0.0.1:8504`

In this deployment the web server binds `0.0.0.0:8504` **inside the agent container**, and the `work` service publishes that port on the host loopback only (`PI_WEB_BIND_ADDRESS` defaults to `127.0.0.1`). Do not change the bind host back to `127.0.0.1` inside the container: Docker's port publishing connects to the container's bridge address, so the UI would become unreachable.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PI_WEB_PORT` / `PORT` | `8504` | Web server port |
| `PI_WEB_HOST` | `127.0.0.1` | Web server bind host; this stack sets it to `0.0.0.0` so the published port can connect (host-side exposure is the `work` service's `PI_WEB_BIND_ADDRESS`) |
| `PI_WEB_DATA_DIR` | `~/.pi-web` | Pi Web data directory (projects.json, daemon state) |
| `PI_WEB_SESSIOND_SOCKET` | `$PI_WEB_DATA_DIR/sessiond.sock` | Unix socket path for session daemon |
| `PI_WEB_SESSIOND_PORT` | — | Optional TCP port for daemon (if unset, uses Unix socket) |
| `PI_WEB_SESSIOND_URL` | — | Daemon URL for web process TCP connection |
| `PI_WEB_PROJECTS_FILE` | `$PI_WEB_DATA_DIR/projects.json` | Override projects storage file |

### Persistent state

Pi Web stores its state at `~/.pi-web/`:
- `projects.json` — list of server-side projects
- `sessiond.sock` — Unix socket for session daemon communication
- Active session runtimes and WebSockets — in-memory in the session daemon

This directory is bind-mounted to `.pi/web/` on the host for persistence.

Pi Web upgrades to WebSockets for workspace terminals (`…/terminals/<id>/socket`) and for its event stream (`/api/machines/local/events`). Browsers connect directly to the published port; there is no reverse proxy in the stack.

### Core model

Pi Web organizes work into three levels:
- **Project** — a folder on the server
- **Workspace** — a git worktree, or the project folder for non-git projects
- **Session** — a chat with Pi Coding Agent running inside a workspace

Pi Web reuses existing Pi auth and model configuration from `~/.pi/agent/`.

---

## CI/CD

The GitHub Actions workflow at `.github/workflows/docker.yml` builds and pushes the single agent image (`Dockerfile`) to `ghcr.io/<owner>/<repo>`, on every push to `main`. The separate `proxy/Dockerfile` and its matrix leg were removed with the Squid apparatus.

Images are tagged with:
- branch name (e.g. `main`)
- git SHA prefix (`sha-abc1234`)

(semver patterns are configured in `metadata-action`, but the workflow is not triggered by tag pushes today.)

---

## Gathering documentation

You are better off gathering documentation for `pi.dev` rather than trying to introspect the code or use intellisense to determine the API surfaces. The documentation files live at:

```
https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/<path>
```

### Documentation index

**Start here**
- [Overview](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/index.md)
- [Quickstart](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/quickstart.md)
- [Using Pi](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/usage.md)
- [Providers](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/providers.md)
- [Settings](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/settings.md)
- [Keybindings](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/keybindings.md)
- [Sessions](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/sessions.md)
- [Compaction](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/compaction.md)

**Customization**
- [Extensions](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/extensions.md)
- [Skills](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/skills.md)
- [Prompt Templates](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/prompt-templates.md)
- [Themes](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/themes.md)
- [Pi Packages](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/packages.md)
- [Custom Models](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/models.md)
- [Custom Providers](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/custom-provider.md)

**Reference**
- [Session Format](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/session-format.md)

**Programmatic Usage**
- [SDK](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/sdk.md)
- [RPC Mode](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/rpc.md)
- [JSON Event Stream Mode](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/json.md)
- [TUI Components](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/tui.md)

**Development**
- [Development](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/development.md)
