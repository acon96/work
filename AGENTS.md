# AGENTS.md — guidelines for developing `work`

This document is for AI agents (and humans) doing further development on this repository.

---

## Repository layout

```
work/
├── Dockerfile                   Main container image (Node 24 LTS)
├── docker-compose.yml           Compose config (work + searxng + optional llama-swap)
├── package.json                 Pinned pi-extensions dependencies
├── .pi/
│   ├── agent/
│   │   ├── settings.json        pi global settings (default provider, extensions, packages)
│   │   └── models.json          pi models config (llama-swap field mapping)
│   ├── sessions/                Persistent session data (bind-mounted)
│   └── web/                     Pi Web state (bind-mounted)
├── config/
│   ├── agent.gitconfig          Default git config for agent user
│   ├── proxy-allowlist.txt      User-editable proxy domain allowlist (Mode A)
│   ├── sudo-allowlist.txt       User-editable sudo command allowlist
│   ├── squid-allowlist.conf     Squid config rendered for Mode A
│   ├── squid-open-get.conf      Squid config rendered for Mode B
│   ├── dnsmasq-allowlist.conf   dnsmasq config for Mode A (default-deny)
│   ├── dnsmasq-open.conf        dnsmasq config for Mode B (permissive)
│   ├── searxng-settings.yml     SearXNG search engine configuration
│   └── llama-swap.yml           llama-swap service configuration
├── scripts/
│   ├── entrypoint.sh            Container start-up script
│   ├── network-mode.sh          Runtime network mode switcher (reloads dnsmasq/squid)
│   ├── healthcheck.sh           Docker healthcheck script
│   └── squid-url-rewrite.py     URL rewrite helper (strips query strings, Mode B)
├── extensions/
│   ├── system-prompt.ts         pi extension: injects sandbox env details into system prompt
│   ├── network-mode.ts          pi extension: runtime network mode status/switch tool + /network
│   ├── llama-swap.ts            pi extension: llama-swap dynamic model discovery + field mapping
│   ├── tools.ts                 pi extension: runtime tool toggling
│   ├── scheduler.ts             pi extension: scheduled tasks via supercronic
│   ├── todo.ts                  pi extension: persistent todo list
│   └── superagent.ts            pi extension: weak-model-gathers, strong-model-plans hybrid
├── skills/
│   ├── notify/                  pi skill: ntfy.sh push notifications
│   └── superagent/              pi skill: superagent planning workflow guide
└── .github/workflows/docker.yml CI/CD: build & publish image on push to main
```

---

## Core invariants — never violate these

1. **There is only one runtime user: `agent` (uid 1001).** Never create additional users (`work`, `node`, etc.) for runtime use. Use `root` or `gosu root` only for privileged build steps.
2. **All outbound traffic from the container is routed through squid (port 3128).** Do not add firewall rules or iptables that bypass this.
3. **Sudo commands are enforced by dynamically-generated `/etc/sudoers`** — at startup, the entrypoint converts `/config/sudo-allowlist.txt` into sudoers Cmnd_Alias directives, validates it with `visudo -c`, then attempts `chattr +i` to make it immutable (requires `CAP_LINUX_IMMUTABLE`). The file is already protected by Unix permissions (root:root 0440), so the immutable flag is defense-in-depth.
4. **Mode A (allowlist)** is the secure default. Mode B (open-GET) trades security for convenience — never make Mode B the default.
5. **The squid MITM CA private key is generated at first startup** and never exported. Do not add steps that print or persist `/etc/squid/ssl-ca.key`.
6. **Session data persists via bind mounts** at `/home/agent/.pi/agent/sessions` (from `.pi/sessions`), `/home/agent/.pi/agent/settings.json` (from `.pi/agent/settings.json`), and `/home/agent/.pi/web` (from `.pi/web`). Never hardcode paths to non-persistent locations.

---

## Extending extensions

All extensions live in `extensions/*.ts` and implement `ExtensionAPI` from `@earendil-works/pi-coding-agent`.

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

See `extensions/pi-superagent.README.md` for full documentation.

---

## Docker & proxy

### Adding an allowlisted domain

Append to `config/proxy-allowlist.txt`. The entry must be a bare domain (e.g. `pypi.org`); squid's `dstdomain` ACL automatically matches subdomains.  The entrypoint also appends a `server=/<domain>/8.8.8.8` dnsmasq directive so DNS resolves correctly in Mode A.

Alternatively, pass the allowlist inline via the `PROXY_ALLOWLIST` env var (comma-separated domains).

### Adding an allowlisted sudo command

Append the command (without `sudo` prefix) to `config/sudo-allowlist.txt`, e.g.:
```
apt-get install -y curl
```

Alternatively, pass the allowlist inline via the `SUDO_ALLOWLIST` env var (comma-separated commands).

### Switching network modes

Set `NETWORK_MODE=open-get` via environment variable (docker-compose or docker run `-e`).

For runtime switching without container restart, use the `network_mode` tool or `/network` command.
These call `/usr/local/bin/network-mode` through sudo (must be allowlisted in `config/sudo-allowlist.txt`).

### Enabling URL rewriting (Mode B)

Set `URL_REWRITE_ENABLED=true` via environment variable. This appends `url_rewrite_program` directives to the Mode B squid config at runtime.

---

## pi extension configuration

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
- `llama-swap`: llama-swap base URL, API key, and field mapping from llama-swap metadata to pi model properties

### SearXNG

The SearXNG URL is configured via `SEARXNG_URL` env var.  The `pi-searxng` extension reads this from the environment at runtime.

---

## Pi Web

Pi Web is a web control plane for Pi Coding Agent with a split-process architecture:
- **Session daemon** (`pi-web-sessiond`): owns active Pi session runtimes, listens on Unix socket at `~/.pi-web/sessiond.sock`
- **Web server** (`pi-web-server`): serves the API and browser UI, defaults to `127.0.0.1:8504`

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PI_WEB_PORT` / `PORT` | `8504` | Web server port |
| `PI_WEB_HOST` | `127.0.0.1` | Web server bind host (use `0.0.0.0` to bind all interfaces) |
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

This directory is bind-mounted to `.pi-web/` on the host for persistence.

### Core model

Pi Web organizes work into three levels:
- **Project** — a folder on the server
- **Workspace** — a git worktree, or the project folder for non-git projects
- **Session** — a chat with Pi Coding Agent running inside a workspace

Pi Web reuses existing Pi auth and model configuration from `~/.pi/agent/`.

---

## CI/CD

The GitHub Actions workflow at `.github/workflows/docker.yml` builds and pushes the image to `ghcr.io/<owner>/<repo>` on every push to `main` and on version tags.  Pull request builds run without pushing.

The image is tagged with:
- branch name (e.g. `main`)
- git SHA prefix (`sha-abc1234`)

---

## Testing checklist before merging

- [ ] `docker compose build` completes without errors
- [ ] `NETWORK_MODE=allowlist docker compose up` — verify squid blocks non-allowlisted domains
- [ ] `NETWORK_MODE=open-get docker compose up` — verify only GET/HEAD pass; POST returns 403
- [ ] `URL_REWRITE_ENABLED=true docker compose up` — verify URL rewrite program runs in Mode B
- [ ] sudoers file is immutable (`lsattr /etc/sudoers` shows `i` flag with CAP_LINUX_IMMUTABLE)
- [ ] unlisted sudo commands are blocked by sudoers (exit code 1, sudo error message)
- [ ] scheduler extension creates tasks and supercronic executes them
- [ ] todo extension persists across session restart
- [ ] pi-superagent extension loads and `/superagent models` lists available models
- [ ] SearXNG container starts and responds on port 8080
- [ ] `.pi/sessions` bind mount persists session data across container rebuilds
- [ ] Pi Web web server starts and responds on port 8504
- [ ] Healthcheck passes for work container (squid, dnsmasq, pi-web, supercronic)
- [ ] Healthcheck passes for searxng container

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
