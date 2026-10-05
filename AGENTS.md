# AGENTS.md — guidelines for developing `work`

This document is for AI agents (and humans) doing further development on this repository.

## General Behavior
1. Do not use special symbols or non-standard Unicode characters because they can cause encoding issues. Prefer ASCII character art such as `->`.

---

## Repository layout

```
work/
├── Dockerfile                   Agent image (Node 24 LTS); uid 1001, no root/sudo/proxy;
│                                includes bubblewrap/socat/ripgrep for pi-sandbox
├── docker-compose.yml           Compose: work + searxng (+ llama-swap)
├── package.json                 Pinned pi-extensions dependencies (pi 1.x)
├── .pi/
│   ├── agent/
│   │   ├── settings.json        pi global settings (default provider, extensions, packages)
│   │   ├── models.json          pi models config (llama-swap field mapping)
│   │   └── sessions/            Persistent session data (bind-mounted)
│   ├── scheduled/               Scheduler state: crontab + run history/dirs (bind-mounted)
│   └── web/                     Pi Web state (bind-mounted)
├── config/
│   ├── agent.gitconfig          Default git config for agent user
│   ├── pi-sandbox-config.json   pi-sandbox policy: domain baseline + human approval, subagents off
│   ├── pi-permission-system-config.json
│   │                            pi-permission-system policy: human prompts, no authorizerChain
│   ├── web-search.json          pi-web-access policy: SearXNG-only search, SSRF guard ranges
│   ├── searxng-settings.yml     SearXNG search engine configuration
│   └── llama-swap.yml           llama-swap service configuration
├── scripts/
│   ├── entrypoint.sh            Agent start-up as uid 1001: sessiond, supercronic
│   ├── healthcheck.sh           Docker healthcheck: verifies bwrap can create sandboxes
│   ├── build-plugins.sh         Compiles TypeScript pi-web plugins to JS during Docker build
│   └── scheduler-run.sh         Cron job wrapper: decodes task, runs pi, persists diagnostics
├── extensions/
│   ├── chat-titles/            pi extension: auto-generates concise session titles from first user prompt
│   ├── system-prompt/           pi extension: injects sandbox env details into system prompt
│   ├── llama-swap/              pi extension: llama-swap dynamic model discovery + field mapping
│   ├── scheduler/               pi extension: scheduled tasks via supercronic
│   ├── todo/                    pi extension: persistent todo list
│   └── superagent/              pi extension: weak-model-gathers, strong-model-plans hybrid
├── skills/
│   ├── notify/                  pi skill: ntfy.sh push notifications
│   ├── superagent/              pi skill: superagent planning workflow guide
│   └── wiki-js/                 pi skill: operational workflow for Wiki.js page/asset/nav management
├── pi-web-plugins/              Pi Web plugin overrides (merged into npm package dist)
│   └── scheduler-history/       Pi Web plugin: workspace panel for scheduled run history
└── .github/workflows/docker.yml CI/CD: builds & publishes the image on push to main
```

---

## Core invariants — never violate these

1. **There is only one runtime user: `agent` (uid 1001), and the agent container runs as it.** `USER agent` is set in the image and `user: "1001:1001"` in Compose. There is no sudo, no gosu, no root entrypoint, and no `CAP_*` on the agent container.
2. **The Pi Web UI port is published on the host loopback only.** The `work` service maps `${PI_WEB_BIND_ADDRESS:-127.0.0.1}:${PI_WEB_PORT:-8504}:8504`. Never widen `PI_WEB_BIND_ADDRESS`: pi-web is not a permission boundary; pi-permission-system and pi-sandbox enforce policy.
3. **Network and Bash policy is enforced by pi-sandbox, not by infrastructure or env vars.** `config/pi-sandbox-config.json` is the single policy source of truth, installed at `~/.pi/agent/extensions/pi-sandbox/config.json` (read-only bind mount; pi-sandbox also write-protects it against sandboxed commands). `network.allowedDomains` is the silent baseline; unmatched destinations prompt the human in the session UI once per connection. The model-backed reviewer (`pi-auto-review`) must stay UNLOADED: it is an npm dependency of pi-sandbox but must never appear in `packages` in settings.json -- with no broker registered, pi-sandbox falls through to interactive human approval, which is the whole point. `subagents.provider` must stay `off` and `hostIPC.mode` must stay `off`. Squid, the MITM CA, and the separate proxy container were removed deliberately in favor of per-Bash-command bubblewrap enforcement; do not reintroduce them half-way.
4. **Tool/file policy is enforced by pi-permission-system.** `config/pi-permission-system-config.json` (installed at `~/.pi/agent/extensions/pi-permission-system/config.json`, read-only) configures human prompts only: no `authorizerChain`, so no model-backed reviewer ever runs. Keep `external_directory: ask` and the secret-file `deny` block.
5. **The sandbox substrate must be verified, not assumed.** The container healthcheck runs `bwrap --ro-bind / / --unshare-all --share-net /bin/true`; if user namespaces, seccomp, or AppArmor on the host/node block that, the stack reports unhealthy rather than running unenforced. On Kubernetes nodes this requires usable unprivileged user namespaces (on AppArmor-enforcing nodes: a bwrap profile, or `kernel.apparmor_restrict_unprivileged_userns=0`) and a permissive-enough seccomp profile.
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

**Usage:**
The local model calls the `superagent_plan` tool with:
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

Squid and the separate proxy container are gone. Network policy for Bash is
enforced per-command inside `work` by pi-sandbox (bubblewrap network
namespaces + policy broker). The Pi process itself and the pi-sandbox broker
use `agent-net` directly; sandboxed Bash commands get a private namespace
whose only exit is the broker's policy proxy.

The `agent-net` subnet is pinned so the SearXNG address in
`config/web-search.json` -> `ssrf.allowRanges` stays stable; update both together
when deploying (e.g. Kubernetes pod IP for SearXNG).

### Runtime requirements for pi-sandbox

- `bubblewrap`, `socat`, `ripgrep` installed in the image (see Dockerfile).
- Unprivileged user namespaces usable inside the container: keep
  `seccomp:unconfined` (or an equivalent profile allowing `unshare`/`clone3`),
  and on AppArmor-enforcing Kubernetes nodes install a bwrap profile or set
  `kernel.apparmor_restrict_unprivileged_userns=0`.
- The container healthcheck fails if `bwrap --ro-bind / / --unshare-all
  --share-net /bin/true` cannot run, so a node that breaks sandboxing shows up
  as unhealthy rather than silently unenforced.

### Adding an allowlisted domain

Two ways:

1. **Per-connection (default flow):** Bash reaching a domain that is not in
   `network.allowedDomains` prompts the human in the session UI ("Allow this
   exact operation once" / "Deny"). The approval covers that one
   hostname:port connection; a new connection prompts again. No file edit and
   no reload needed. Sessions without UI (scheduler tasks) are denied.
2. **Permanent baseline:** edit `config/pi-sandbox-config.json` ->
   `network.allowedDomains`. Entries are exact domains, strict-subdomain
   wildcards (`*.example.com` -- note this does NOT match the apex domain),
   and optional `:port` restrictions. The file is a read-only bind mount:
   edit it on the host, then start a new session (pi loads config at
   extension registration; there is no hot reload). No container restart is
   required.

The broker only evaluates **public** hostnames (names with a dot, resolving
outside private/loopback ranges). Sandbox-ed Bash therefore can never reach
service names like `searxng` or `llama-swap` -- those must go through Pi's own
tools (web_search, model providers), which run outside the Bash jail. If a
Bash command genuinely needs an internal service, that is a design decision
to make explicitly, not an allowlist edit.

### Changing policy (operator only)

Policy lives in the two read-only bind mounts under
`/home/agent/.pi/agent/extensions/`. There is deliberately no agent-side
control path (no tool, no slash command, no script in the agent image); do not
add one back. Keep `subagents.provider: "off"` and `hostIPC.mode: "off"`.

The network review chain is: static deny -> static allow -> human prompt.
The model-backed reviewer (`pi-auto-review`) is intentionally never enabled:
do not add it to `packages` in settings.json or to `authorizerChain` in the
pi-permission-system config. With no reviewer broker registered, pi-sandbox's
`approval.ts` falls through to its built-in interactive UI prompt. Setting
`network.strictAllowlist: true` would skip the human prompt and deny
everything unmatched -- use only for locked-down one-shot runs.

### Containment checks

Run these after any topology, image, or policy change. Note these checks are
run via `docker compose exec`, i.e. OUTSIDE a Pi Bash tool call, so they test
the container, not the pi-sandbox broker. To test pi-sandbox itself, run the
same probes from inside a Pi session's Bash tool.

```bash
# expected to succeed from the Pi process (egress exists for the container)
docker compose exec work curl -sS -o /dev/null -w '%{http_code}\n' https://api.anthropic.com/

# inside a Pi Bash tool: allowlisted domain succeeds; anything else raises a
# human approval prompt in the session UI ("Allow this exact operation once")
#   curl -sS -o /dev/null -w '%{http_code}' https://api.anthropic.com/   -> 200/4xx
#   curl -sS -o /dev/null -w '%{http_code}' https://example.com          -> denied

# expected: writes outside the workspace from a Bash tool fail
#   touch /etc/test -> denied; touch /home/agent/test -> denied

# expected: uid 1001, no sudo, no capabilities
docker compose exec work sh -c 'id -u; command -v sudo || echo "no sudo"'

# expected: healthcheck goes UNHEALTHY if bwrap cannot sandbox
docker compose exec work healthcheck
```

Passing these in Compose demonstrates the data path. It is **not** evidence that
Kubernetes NetworkPolicy works; the cluster needs the same checks re-run.

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

This file is bind-mounted into the container at `/home/agent/.pi/agent/settings.json`.  It configures:
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

The SearXNG endpoint is configured via the `SEARXNG_BASE_URL` env var, read at
runtime by the `pi-web-access` extension (`web_search` tool). Search providers
are pinned to SearXNG via `config/web-search.json` -> `webSearch.allowedProviders`;
the SSRF guard's `ssrf.allowRanges` must cover the SearXNG address for it to be
reachable.

---

## Pi Web

Pi Web is a web control plane for Pi Coding Agent with a split-process architecture:
- **Session daemon** (`pi-web-sessiond`): owns active Pi session runtimes, listens on Unix socket at `~/.pi-web/sessiond.sock`
- **Web server** (`pi-web-server`): serves the API and browser UI, defaults to `127.0.0.1:8504`

In this deployment the web server binds `0.0.0.0:8504` **inside the agent
container**, and the `work` service publishes that port on the host loopback
only (`PI_WEB_BIND_ADDRESS` defaults to `127.0.0.1`). Do not change the bind
host back to `127.0.0.1` inside the container: Docker's port publishing
connects to the container's bridge address, so the UI would become unreachable.

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

Pi Web upgrades to WebSockets for workspace terminals (`…/terminals/<id>/socket`)
and for its event stream (`/api/machines/local/events`). Browsers connect
directly to the published port; there is no reverse proxy in the stack.

### Core model

Pi Web organizes work into three levels:
- **Project** — a folder on the server
- **Workspace** — a git worktree, or the project folder for non-git projects
- **Session** — a chat with Pi Coding Agent running inside a workspace

Pi Web reuses existing Pi auth and model configuration from `~/.pi/agent/`.

---

## CI/CD

The GitHub Actions workflow at `.github/workflows/docker.yml` builds and pushes
the single agent image (`Dockerfile`) to `ghcr.io/<owner>/<repo>`, on every push
to `main`. The separate `proxy/Dockerfile` and its matrix leg were removed with
the Squid apparatus.

Images are tagged with:
- branch name (e.g. `main`)
- git SHA prefix (`sha-abc1234`)

(semver patterns are configured in `metadata-action`, but the workflow is not
triggered by tag pushes today.)

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
