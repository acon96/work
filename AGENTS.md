# AGENTS.md — guidelines for developing `work`

This document is for AI agents (and humans) doing further development on this repository.

---

## Repository layout

```
work/
├── Dockerfile                   Main container image (Node 24 LTS)
├── docker-compose.yml           Compose config (work + searxng)
├── package.json                 Pinned pi-extensions dependencies
├── .pi/
│   └── settings.json            pi sessionDir + packages + extensions
├── config/
│   ├── proxy-allowlist.txt      User-editable proxy domain allowlist (Mode A)
│   ├── sudo-allowlist.txt       User-editable sudo command allowlist
│   ├── squid-allowlist.conf     Squid config rendered for Mode A
│   ├── squid-open-get.conf      Squid config rendered for Mode B
│   ├── dnsmasq-allowlist.conf   dnsmasq config for Mode A (default-deny)
│   ├── dnsmasq-open.conf        dnsmasq config for Mode B (permissive)
│   └── searxng-settings.yml     SearXNG search engine configuration
├── scripts/
│   ├── entrypoint.sh            Container start-up script
│   ├── docker-run.sh            Convenience host launcher
│   └── squid-url-rewrite.py     URL rewrite helper (strips query strings, Mode B)
├── extensions/
│   ├── sudo-gate.ts             pi extension: intercepts dangerous bash calls
│   ├── tools.ts                 pi extension: runtime tool toggling
│   ├── watch.ts                 pi extension: polling watches
│   └── todo.ts                  pi extension: persistent todo list
└── .github/workflows/docker.yml CI/CD: build & publish image on push to main
```

---

## Core invariants — never violate these

1. **There is only one runtime user: `agent` (uid 1001).** Never create additional users (`work`, `node`, etc.) for runtime use. Use `root` or `gosu root` only for privileged build steps.
2. **All outbound traffic from the container is routed through squid (port 3128).** Do not add firewall rules or iptables that bypass this.
3. **`rm -rf` and `chmod/chown 777` are unconditionally blocked** by `extensions/sudo-gate.ts`, regardless of allowlists.
4. **Mode A (allowlist)** is the secure default. Mode B (open-GET) trades security for convenience — never make Mode B the default.
5. **The squid MITM CA private key is generated at build time** and never exported. Do not add steps that print or persist `/etc/squid/ssl-ca.key`.
6. **Session data persists via the `pi-data` Docker volume** at `/home/agent/.pi/sessions`. The global settings live at `/home/agent/.pi/agent/settings.json`. Never hardcode sessionDir to a non-persistent path.

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

---

## Docker & proxy

### Adding an allowlisted domain

Append to `config/proxy-allowlist.txt`. The entry must be a bare domain (e.g. `pypi.org`); squid's `dstdomain` ACL automatically matches subdomains.  The entrypoint also appends a `server=/<domain>/8.8.8.8` dnsmasq directive so DNS resolves correctly in Mode A.

Alternatively, pass the allowlist inline via the `PROXY_ALLOWLIST` env var (newline-separated domains).

### Adding an allowlisted sudo command

Append the full command (including `sudo`) to `config/sudo-allowlist.txt`, e.g.:
```
sudo apt-get install -y curl
```

Alternatively, pass the allowlist inline via the `SUDO_ALLOWLIST` env var (newline-separated commands).

### Switching network modes

Set `NETWORK_MODE=open-get` via environment variable (docker-compose or docker run `-e`).

### Enabling URL rewriting (Mode B)

Set `URL_REWRITE_ENABLED=true` via environment variable. This appends `url_rewrite_program` directives to the Mode B squid config at runtime.

---

## pi extension configuration

### package.json

All off-the-shelf pi extensions are declared as `dependencies` with pinned versions.  The `pi` key declares local extension paths for the gallery.

### .pi/settings.json

This file is copied into the container and bootstrapped for the `agent` user at runtime.  It configures:
- `sessionDir`: where session files are stored (persisted via Docker volume)
- `extensions`: paths to local extension directories
- `packages`: npm packages to load resources from (pinned versions)

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
- semantic version (`v1.2.3` → `1.2.3` and `1.2`)
- git SHA prefix (`sha-abc1234`)

---

## Testing checklist before merging

- [ ] `docker compose build` completes without errors
- [ ] `NETWORK_MODE=allowlist docker compose up` — verify squid blocks non-allowlisted domains
- [ ] `NETWORK_MODE=open-get docker compose up` — verify only GET/HEAD pass; POST returns 403
- [ ] `URL_REWRITE_ENABLED=true docker compose up` — verify URL rewrite program runs in Mode B
- [ ] sudo-gate extension blocks `rm -rf /` and `chmod 777 /etc` tool calls
- [ ] sudo-gate extension blocks unlisted sudo commands
- [ ] watch extension creates, fires, and auto-cancels correctly
- [ ] todo extension persists across session restart
- [ ] SearXNG container starts and responds on port 8080
- [ ] `pi-data` volume persists session data across container rebuilds
- [ ] Pi Web web server starts and responds on port 8504

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
