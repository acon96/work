# work

A hardened Docker sandbox for light AI agent development and research tasks, powered by [pi](https://pi.dev).

---

## Architecture overview

```
┌───────────────────────────────────────────────────────────────────┐
│  Docker Compose network                                            │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  work container (Node 24 LTS)                               │   │
│  │                                                             │   │
 │  ┌────────────────────────────────────────────────────┐    │   │
  │  │  pi server (user: agent)                           │    │   │
  │  │  bash / fs / other tools ── extension hooks        │    │   │
  │  └────────────────────────────────────────────────────┘    │   │
│  │          │                                   │              │   │
│  │          │  outbound HTTP/HTTPS              │              │   │
│  │          ▼                                   ▼              │   │
│  │  ┌────────────────────────────────────────────────────┐    │   │
│  │  │  squid (port 3128)                                 │    │   │
│  │  │  Mode A: CONNECT-only to allowlisted domains       │    │   │
│  │  │  Mode B: GET/HEAD-only, SSL bump, strip headers    │    │   │
│  │  └────────────────────────────────────────────────────┘    │   │
│  │          │                                                  │   │
│  │          ▼                                                  │   │
│  │  ┌──────────────────────┐                                   │   │
│  │  │  dnsmasq (127.0.0.1) │                                   │   │
│  │  │  Mode A: default-deny│                                   │   │
│  │  │  Mode B: permissive  │                                   │   │
│  │  └──────────────────────┘                                   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  searxng container                                          │   │
│  │  Open-source metasearch engine (port 8080)                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
```

### Security layers

| Layer | Mechanism | Blocks |
|---|---|---|
| Process | `pi-sudo-gate` extension | `sudo` (allowlist + approval), `rm -rf`, `chmod/chown 777` |
| Network | squid proxy (Mode A) | All outbound except allowlisted HTTPS CONNECT |
| Network | squid proxy (Mode B) | POST/PUT/PATCH, query strings, sensitive headers |
| DNS | dnsmasq (Mode A) | All non-allowlisted hostnames → `0.0.0.0` |
| OS | Docker `cap_drop` | `NET_RAW`, `NET_ADMIN`, `SYS_PTRACE` |
| OS | Docker seccomp | Default Docker profile |

---

## Quick start

### Prerequisites

- Docker ≥ 24
- Docker Compose v2

### 1. Build the image

```bash
docker compose build
```

Or pull the pre-built image:

```bash
docker pull ghcr.io/<owner>/work:main
```

### 2. Configure

Edit `config/proxy-allowlist.txt` to add domains the agent needs to reach:

```
api.anthropic.com
registry.npmjs.org
github.com
```

Edit `config/sudo-allowlist.txt` to allow specific sudo commands (empty by default):

```
sudo apt-get install -y curl
```

### 3. Run

```bash
ANTHROPIC_API_KEY=sk-... ./scripts/docker-run.sh
```

Or with Docker Compose:

```bash
ANTHROPIC_API_KEY=sk-... docker compose up
```

Open the pi web UI at **http://localhost:4000** and SearXNG at **http://localhost:8080**.

---

## Configuration reference

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `NETWORK_MODE` | `allowlist` | `allowlist` — strict outbound control; `open-get` — all domains but GET/HEAD only |
| `WORKSPACE_DIR` | `./workspace` | Host path mounted as `/workspace` |
| `CONFIG_DIR` | `./config` | Host path mounted as `/config` |
| `PI_PORT` | `4000` | Host port for the pi web UI |
| `SEARXNG_PORT` | `8080` | Host port for SearXNG |
| `SEARXNG_URL` | `http://searxng:8080` | SearXNG endpoint (internal Docker URL); set to a custom URL for external SearXNG |
| `URL_REWRITE_ENABLED` | `false` | Enable optional URL query-string stripping in Mode B (uses `squid-url-rewrite.py`) |
| `PROXY_ALLOWLIST` | — | Newline-separated domains; overrides `config/proxy-allowlist.txt` at runtime |
| `SUDO_ALLOWLIST` | — | Newline-separated sudo commands; overrides `config/sudo-allowlist.txt` at runtime |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `OPENAI_API_KEY` | — | OpenAI API key |

### config/proxy-allowlist.txt

One domain per line; subdomains are matched automatically.  Blank lines and `#` comments are ignored.  Used in Mode A (squid allowlist + dnsmasq default-deny).  Can be overridden at runtime via the `PROXY_ALLOWLIST` env var.

### config/sudo-allowlist.txt

One full command per line including the `sudo` prefix.  Empty by default.  Commands not listed here are blocked by the `sudo-gate` pi extension.  Can be overridden at runtime via the `SUDO_ALLOWLIST` env var.

### config/searxng-settings.yml

SearXNG configuration file.  Defines enabled search engines, safe-search level, and server settings.  Mounted read-only into the searxng container.

---

## pi extensions

### Local extensions (bundled)

| Extension | File | Purpose |
|---|---|---|
| `pi-sudo-gate` | `extensions/sudo-gate.ts` | Intercepts `bash` tool calls; blocks dangerous commands; requires allowlist check + UI confirmation for `sudo` |
| `pi-tools` | `extensions/tools.ts` | `/tools` command; runtime enable/disable of individual tools; persists selection |
| `pi-watch` | `extensions/watch.ts` | `watch` tool; polls a shell command; fires a follow-up message when a condition is met |
| `pi-todo` | `extensions/todo.ts` | `todo` tool; persistent todo list (add / complete / delete / list) |

### Off-the-shelf extensions (loaded via `package.json` → `pi install`)

| Extension | Pinned Version | Purpose |
|---|---|---|
| `@jmfederico/pi-web` | `0.13.4` | Web browsing extension |
| `pi-searxng` | `1.0.4` | SearXNG search integration |
| `pi-drawio` | `0.1.0` | Draw.io diagram editor |
| `pi-wiki` | `2.0.0` | Wikipedia search |
| `pi-lens` | `3.8.44` | Code lens / language server integration |
| `pi-subagents` | `0.24.2` | Spawn sub-agent sessions |
| `pi-schedule-prompt` | `0.3.0` | Scheduled prompt execution |

### Session persistence

Session data is stored in `.pi/sessions` (configured via `.pi/settings.json` → `sessionDir`).  The `pi-data` named Docker volume persists this directory across container rebuilds.

---

## Network modes in detail

### Mode A — Allowlist (default)

- Squid listens on port 3128, accepts only `CONNECT` to allowlisted domains.
- dnsmasq returns `0.0.0.0` for all domains by default; only allowlisted domains receive real DNS lookups (forwarded to `8.8.8.8`).
- Designed to prevent bulk data exfiltration and DNS-based exfiltration.

### Mode B — Open-GET

- Squid performs TLS interception (SSL bump) using a build-time self-signed CA injected into the container's trust store.
- Only `GET` and `HEAD` methods are forwarded; all others return `403`.
- All request headers except a small safe set (`Host`, `Accept`, `Accept-Language`, `Accept-Encoding`, `User-Agent`, `Cache-Control`) are stripped.
- Query strings are removed from all URLs before forwarding (optional, enabled via `URL_REWRITE_ENABLED=true`).
- dnsmasq forwards all queries upstream.
- Designed for read-only browsing/research with reduced header leakage.

---

## Development

See [AGENTS.md](AGENTS.md) for coding conventions and testing checklist.
