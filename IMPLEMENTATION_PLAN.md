# work — Implementation Plan

Work is a web-based agent sandbox for light development/research tasks. It consists of a hardened Docker sandbox and a set of `pi.dev` extensions.

---

## Feature List

### 1. Docker Sandbox Infrastructure

#### 1.1 Dockerfile (`Dockerfile`)
- [ ] Base image: `node:22-slim` (Debian slim)
- [ ] Two users: `work` (runs the server, owns `/app`) and `agent` (runs pi processes, heavily restricted)
- [ ] `sudo` installed; `agent` sudoers configured for allowlist-only, gated by a runtime approval token (set by the server after user confirms via `pi-sudo-gate` → `extension_ui_request` relay)
- [ ] Capabilities dropped: `NET_RAW`, `NET_ADMIN`, `SYS_PTRACE`
- [ ] Seccomp: Docker default profile (tighten incrementally)
- [ ] `http_proxy` / `https_proxy` env vars set for `agent` user so all outbound traffic routes through squid

#### 1.2 Network Proxy (squid)
- [ ] Two mutually exclusive modes via `NETWORK_MODE` env var:
  - **Mode A — Allowlist (default):** Domain allowlist from `/config/proxy-allowlist.txt`; HTTPS CONNECT tunneling only; dnsmasq default-deny as second layer
  - **Mode B — Open-GET:** All domains, GET/HEAD only; squid strips all request headers except a fixed safe set and rewrites URLs to strip query strings; requires MITM TLS (self-signed CA injected at build time)
- [ ] Security guarantees: block HTTP bulk exfiltration, block DNS exfiltration (Mode A), prevent raw socket bypass, enforce non-root + sudo UI approval

#### 1.3 DNS (dnsmasq)
- [ ] Mode A: `address=/#/0.0.0.0` default-deny, explicit forwards per allowlisted domain
- [ ] Mode B: Permissive upstream forwarding
- [ ] `/etc/resolv.conf` → `127.0.0.1` inside container

#### 1.4 Docker Compose & Config
- [ ] `docker-compose.yml`: workspace volume at `/workspace`, `/config` volume for user-editable files, port mapping, env var passthrough
- [ ] `config/proxy-allowlist.txt`: user-editable; defaults: `api.anthropic.com`, `api.openai.com`, `registry.npmjs.org`, `github.com`, `objects.githubusercontent.com`
- [ ] `config/sudo-allowlist.txt`: user-editable; **empty by default**
- [ ] `scripts/docker-run.sh`: convenience launcher

---

### 2. Pi Extensions (process-side logic)

Extensions live in `extensions/*.ts`. They contain logic that travels with the pi process, not with any particular UI.

#### 2.1 Off-the-shelf extensions
- [ ] Install `npm:npm:@jmfederico/pi-web`
- [ ] Install `npm:pi-searxng` — decide: sidecar process or env-var config inside sandbox
- [ ] Install `npm:pi-drawio`
- [ ] Install `npm:pi-wiki`
- [ ] Install `npm:pi-lens` — ensure linters + language servers are present
- [ ] Install `npm:pi-subagents`
- [ ] Install `npm:pi-schedule-prompt` — or implement custom watch extension if it doesn't work

#### 2.2 `pi-sudo-gate` (`extensions/sudo-gate.ts`)
- [ ] Copy stock `permission-gate.ts` pattern into `extensions/sudo-gate.ts`
- [ ] Add allowlist file check: read `/config/sudo-allowlist.txt` before prompting; deny immediately if command not listed
- [ ] Add timed confirmation: `ctx.ui.confirm(..., { timeout: 30000 })` for auto-deny on timeout with visible countdown
- [ ] Intercepts `bash` tool calls containing `sudo`; requires explicit user approval via `extension_ui_request` relay
- [ ] Also blocks: `rm -rf`, `chmod/chown 777`

#### 2.3 `pi-tools` (`extensions/tools.ts`)
- [ ] Register `/tools` command opening a `ctx.ui.custom()` component (pi's `SettingsList` TUI)
- [ ] Lists all tools from `pi.getAllTools()` with toggle state from `pi.getActiveTools()`
- [ ] On toggle, call `pi.setActiveTools(updatedNames)` — immediate effect, no restart
- [ ] Persist selection via `pi.appendEntry("tool-config", { active: names })`; reconstruct in `session_start`
- [ ] Display as a widget in the web UI (if possible)

#### 2.4 `pi-watch` (custom, if `pi-schedule-prompt` is insufficient)
- [ ] Register `watch` tool: actions `create` | `list` | `cancel`; params: `command`, `poll_every`, `stop_on`, `name`
- [ ] On `create`: validate args, store definition, start `setInterval` polling loop, persist via `pi.appendEntry("watch-state", watches)`
- [ ] Polling loop: run `pi.exec(...)`, evaluate `stop_on` against `{ output, exit_code, prev_output, changed }`, call `pi.sendUserMessage(result, { deliverAs: "followUp" })` on condition fire, then auto-cancel
- [ ] On `session_start`: reconstruct watches from `appendEntry` records, restart timers
- [ ] On `session_shutdown`: `clearInterval` all active timers
- [ ] Constraints: max 5 active watches; poll interval 30s–24h; output truncated at 64 KB

#### 2.5 `pi-todo` (custom)
- [ ] Copy from pi.dev examples; simple todo tool registered as a pi extension

---

### 3. CI/CD & Documentation

- [ ] GitHub Actions pipeline: build and publish Docker image on push to `main`
- [ ] Full documentation: architecture overview, setup instructions, configuration reference
- [ ] `AGENTS.md`: guidelines for further development of the repo