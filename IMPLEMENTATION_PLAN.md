# work — Implementation Plan

Work is a web-based agent sandbox for light development and research tasks. It consists of a hardened Docker sandbox and a set of `pi.dev` extensions.

---

## Feature List

### 1. Docker Sandbox Infrastructure

#### 1.1 Dockerfile (`Dockerfile`)
- [x] Base image: `node:24-slim` (Debian slim, Node 24 LTS)
- [x] Single runtime user: `agent` (uid 1001); `root` reserved for build-time / privileged operations
- [x] `sudo` installed; `agent` sudoers configured for allowlist-only, gated by `sudo-gate.ts` extension
- [x] Capabilities dropped: `NET_RAW`, `NET_ADMIN`, `SYS_PTRACE`
- [x] Seccomp: Docker default profile (tighten incrementally)
- [x] `http_proxy` / `https_proxy` env vars set for `agent` user so all outbound traffic routes through squid
- [x] `jq` installed for env-var parsing
- [x] `package.json` installed via `npm install` for off-the-shelf extensions
- [x] Local extensions copied to `/home/work/.pi/extensions/` for auto-discovery
- [x] `.pi/settings.json` template bootstrapped for `agent` user

#### 1.2 Network Proxy (squid)
- [x] Two mutually exclusive modes via `NETWORK_MODE` env var:
  - **Mode A — Allowlist (default):** Domain allowlist from `/config/proxy-allowlist.txt`; HTTPS CONNECT tunneling only; dnsmasq default-deny as second layer
  - **Mode B — Open-GET:** All domains, GET/HEAD only; squid strips all request headers except a fixed safe set; requires MITM TLS (self-signed CA injected at build time)
- [x] Security guarantees: block HTTP bulk exfiltration, block DNS exfiltration (Mode A), prevent raw socket bypass, enforce non-root + sudo UI approval
- [x] Optional URL rewriting for Mode B via `URL_REWRITE_ENABLED=true` env var (uses `squid-url-rewrite.py`)

#### 1.3 DNS (dnsmasq)
- [x] Mode A: `address=/#/0.0.0.0` default-deny, explicit forwards per allowlisted domain
- [x] Mode B: Permissive upstream forwarding
- [x] `/etc/resolv.conf` → `127.0.0.1` inside container

#### 1.4 Docker Compose & Config
- [x] `docker-compose.yml`: workspace volume at `/workspace`, `/config` volume for user-editable files, `pi-data` named volume for session persistence, port mapping, env var passthrough
- [x] `config/proxy-allowlist.txt`: user-editable; defaults: `api.anthropic.com`, `api.openai.com`, `registry.npmjs.org`, `github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`
- [x] `config/sudo-allowlist.txt`: user-editable; **empty by default**
- [x] `config/searxng-settings.yml`: SearXNG search engine configuration
- [x] `scripts/docker-run.sh`: convenience launcher with all new env vars

---

### 2. Pi Extensions (process-side logic)

Extensions live in `extensions/*.ts`. They contain logic that travels with the pi process, not with any particular UI.

#### 2.1 Off-the-shelf extensions (pinned in `package.json`)
- [x] `@jmfederico/pi-web@1.202605.6` — web browsing
- [x] `pi-searxng@1.0.4` — SearXNG search integration (sidecar container, configured via `SEARXNG_URL` env var)
- [x] `pi-drawio@0.1.0` — Draw.io diagram editor
- [x] `pi-wiki@2.0.0` — Wikipedia search
- [x] `pi-lens@3.8.44` — code lens / language server integration
- [x] `pi-subagents@0.24.2` — spawn sub-agent sessions
- [x] `pi-schedule-prompt@0.3.0` — scheduled prompt execution

#### 2.2 `pi-sudo-gate` (`extensions/sudo-gate.ts`)
- [x] Uses `permission-gate.ts` pattern
- [x] Allowlist file check: reads `/config/sudo-allowlist.txt` before prompting; denies immediately if command not listed
- [x] Timed confirmation: `ctx.ui.confirm(..., { timeout: 30000 })` for auto-deny on timeout
- [x] Intercepts `bash` tool calls containing `sudo`; requires explicit user approval
- [x] Also blocks: `rm -rf`, `chmod/chown 777`

#### 2.3 `pi-tools` (`extensions/tools.ts`)
- [x] `/tools` command: `state`, `toggle <name>`, `set <name1,name2,...>`
- [x] Lists all tools from `pi.getAllTools()` with toggle state from `pi.getActiveTools()`
- [x] On toggle/set, calls `pi.setActiveTools(updatedNames)` — immediate effect, no restart
- [x] Persist selection via `pi.appendEntry("tool-config", { active: names })`; reconstruct in `session_start`
- [x] Emits `tools_state` message for web UI integration

#### 2.4 `pi-watch` (`extensions/watch.ts`)
- [x] Register `watch` tool: actions `create` | `list` | `cancel`; params: `command`, `poll_every`, `stop_on`, `name`
- [x] On `create`: validates args, stores definition, starts `setInterval` polling loop, persists via `pi.appendEntry("watch-state", watches)`
- [x] Polling loop: runs `pi.exec("bash", ["-c", command])`, evaluates `stop_on` against `{ output, exit_code, prev_output, changed }`, calls `pi.sendUserMessage(result, { deliverAs: "followUp" })` on condition fire, then auto-cancels
- [x] On `session_start`/`session_tree`: reconstructs watches from `appendEntry` records, restarts timers
- [x] On `session_shutdown`: `clearInterval` all active timers
- [x] Constraints: max 5 active watches; poll interval 30s–24h; output truncated at 64 KB

#### 2.5 `pi-todo` (`extensions/todo.ts`)
- [x] Simple todo tool registered as a pi extension
- [x] Actions: `add`, `complete`, `delete`, `list`
- [x] Persisted via `pi.appendEntry("todo-state", { items })`; restored on `session_start`/`session_tree`

#### 2.6 Pi Web web control plane (`@jmfederico/pi-web`)
- [x] Installed globally in Docker image via `npm install -g @jmfederico/pi-web`
- [x] Split-process architecture: session daemon (`pi-web-sessiond`) + web server (`pi-web-server`)
- [x] Session daemon started in entrypoint as `agent` user, listens on Unix socket at `~/.pi-web/sessiond.sock`
- [x] Web server started in entrypoint as `agent` user, defaults to `127.0.0.1:8504`
- [x] Persistent data directory at `~/.pi-web/` (projects.json, session daemon state)
- [x] Configurable via env vars: `PI_WEB_PORT`, `PI_WEB_HOST`, `PI_WEB_DATA_DIR`, `PI_WEB_SESSIOND_SOCKET`
- [x] Port 8504 exposed in docker-compose.yml
- [x] Data volume persisted via bind mount to `.pi-web/` on host
- [x] Reuses existing Pi auth and model configuration from `~/.pi/agent/`

---

### 3. pi Extension Configuration

#### 3.1 `package.json`
- [x] All off-the-shelf pi extensions declared as `dependencies` with pinned versions
- [x] `pi` key declares local extension paths for gallery metadata

#### 3.2 `.pi/settings.json`
- [x] `sessionDir`: `/home/agent/.pi/sessions` (persisted via Docker volume)
- [x] `extensions`: `["/home/work/.pi/extensions"]` (local extensions)
- [x] `packages`: all off-the-shelf extensions with pinned versions

#### 3.3 SearXNG integration
- [x] SearXNG sidecar container defined in `docker-compose.yml`
- [x] `SEARXNG_URL` env var passes the endpoint to the pi server
- [x] `pi-searxng` extension reads `SearXNG_URL` from the environment at runtime

---

### 4. CI/CD & Documentation

- [x] GitHub Actions pipeline: build and publish Docker image on push to `main`
- [x] Full documentation: architecture overview, setup instructions, configuration reference
- [x] `AGENTS.md`: guidelines for further development of the repo
- [x] `README.md`: updated with all new env vars, SearXNG, session persistence, and pinned extension versions

---

## Feedback Addressed

| # | Feedback | Status |
|---|----------|--------|
| 1 | Configure correctly per latest pi.dev docs | ✅ Done — imports use `@earendil-works/pi-coding-agent`, tools use `pi.exec("bash", ["-c", cmd])` pattern, `registerTool` uses new object schema |
| 2 | Add SearXNG container + configure pi extension via env vars | ✅ Done — `searxng` service in docker-compose.yml, `SEARXNG_URL` env var, `pi-searxng` in packages |
| 3 | Configure allowlists via env vars | ✅ Done — `PROXY_ALLOWLIST` and `SUDO_ALLOWLIST` env vars override config files at runtime |
| 4 | Persist session data via Docker volume | ✅ Done — `pi-data` named volume at `/home/agent/.pi` in docker-compose.yml |
| 5 | Optional URL filtering/rewrite for Mode B | ✅ Done — `URL_REWRITE_ENABLED=true` appends `url_rewrite_program` directives to squid config |
| 6 | Use Node 24 LTS | ✅ Done — base image changed from `node:22-slim` to `node:24-slim` |
| 7 | Use package.json with pinned versions | ✅ Done — all 7 off-the-shelf extensions declared with pinned versions in `package.json` and `.pi/settings.json` |