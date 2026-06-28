# work

A hardened Docker sandbox for "light" agentic development and research tasks, powered by [pi](https://pi.dev).  Feel free to fork and adapt for your own needs. Just update `package.json` with new extensions and skills, and add any necessary OS-level dependencies to the Dockerfile. Merging to `main` pushes a new `docker` image to GHCR for easy use.

---

## Architecture overview

```mermaid
graph TB
    subgraph docker["Docker Compose Network"]
        subgraph work["work container (Node 24 LTS)"]
            pi["Pi Server<br/>(user: agent)<br/>bash, fs, tools<br/>extension hooks"]
            squid["Squid Proxy<br/>:3128<br/><br/>Mode A: CONNECT-only<br/>to allowlisted domains<br/><br/>Mode B: GET/HEAD-only<br/>SSL bump, strip headers"]
            dnsmasq["dnsmasq<br/>127.0.0.1<br/><br/>Mode A: default-deny<br/>Mode B: permissive"]
            sudoers["/etc/sudoers<br/>(immutable)<br/>Generated from<br/>sudo-allowlist.txt"]
            
            pi -->|HTTP/HTTPS| squid
            pi -->|DNS| dnsmasq
            pi -.->|sudo calls| sudoers
            squid -->|upstream| dnsmasq
        end
        
        searxng["SearXNG<br/>:8080<br/>Metasearch Engine"]
        llama["llama-swap<br/>:8080<br/>(optional)<br/>Dynamic Model<br/>Discovery"]
        
        pi -.->|search| searxng
        pi -.->|models| llama
    end
    
    squid -->|filtered| internet((Internet))
    dnsmasq -->|filtered| internet
```

### Security layers

| Layer   | Mechanism                | Blocks                                                                                                                                    |
|---------|--------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| OS      | Immutable `/etc/sudoers` | Non-allowlisted sudo commands (generated at startup, validated with `visudo -c`, protected by `chattr +i` and root:root 0440 permissions) |
| Network | squid proxy (Mode A)     | All outbound except allowlisted HTTPS CONNECT                                                                                             |
| Network | squid proxy (Mode B)     | POST/PUT/PATCH, query strings, sensitive headers                                                                                          |
| DNS     | dnsmasq (Mode A)         | All non-allowlisted hostnames → `0.0.0.0`                                                                                                 |
| OS      | Docker `cap_drop`        | `NET_RAW`, `NET_ADMIN`, `SYS_PTRACE`                                                                                                      |
| OS      | Docker `cap_add`         | `LINUX_IMMUTABLE` (allows `chattr +i` on sudoers)                                                                                         |
| OS      | Docker seccomp           | Unconfined (allows squid SSL interception)                                                                                                |

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
api.openai.com
api.anthropic.com
registry.npmjs.org
github.com
```

Edit `config/sudo-allowlist.txt` to allow specific sudo commands (empty by default):

```
apt-get update
apt-get install -y curl
```

### 3. Run

Provide any necessary environment variables (e.g., API keys) and start the container:
```bash
LLAMA_SWAP_URL=https://ai.example.com docker compose up
ANTHROPIC_API_KEY=sk-... docker compose up
OPENAI_API_KEY=sk-... docker compose up
GIT_CREDENTIAL_HOST=github.com GIT_CREDENTIAL_USERNAME=oauth2 GIT_CREDENTIAL_PASSWORD=ghp_... docker compose up
```

The system starts three processes inside the container:
- **dnsmasq** — DNS filtering
- **squid** — HTTP/HTTPS proxy  
- **Pi Web** — Web UI and session daemon (ports 8504)

Open the Pi Web UI at **http://localhost:8504** and SearXNG at **http://localhost:8080**.

### Git HTTPS credentials

There is not a strong security boundary between `git` and a credential helper running inside the same `agent` runtime: if the agent can use the credential for `git fetch`, it can usually trigger the same helper path directly. This image therefore supports an explicit startup-time fallback instead of claiming a secret-preserving in-container helper.

At container startup, if git credential env vars are provided, the entrypoint writes them into `/home/agent/.git-credentials`, sets `credential.helper=store`, and persists the config in `/home/agent/.gitconfig`.

Use one of these forms:

```bash
# Single host credential assembled at startup
GIT_CREDENTIAL_HOST=github.com \
GIT_CREDENTIAL_USERNAME=oauth2 \
GIT_CREDENTIAL_PASSWORD=ghp_... \
docker compose up

# Optional repo/path-specific match
GIT_CREDENTIAL_HOST=github.com \
GIT_CREDENTIAL_PATH=owner/repo.git \
GIT_CREDENTIAL_USERNAME=oauth2 \
GIT_CREDENTIAL_PASSWORD=ghp_... \
docker compose up

# Multiple preformatted entries (newline-separated)
GIT_CREDENTIAL_URLS=$'https://oauth2:token1@github.com/owner/repo.git\nhttps://user:token2@gitlab.com/group/project.git' \
docker compose up
```

Notes:
- `GIT_CREDENTIAL_PATH` enables `credential.useHttpPath=true` so git can distinguish per-repo credentials on the same host.
- `GIT_CREDENTIAL_URLS` must already be URL-encoded if usernames or passwords contain reserved URL characters.
- The credentials are persisted on disk inside the container user home; treat this as a convenience fallback, not a secret-isolation mechanism.

### 4. Using Pi Web

Pi Web provides a browser-based interface for interacting with the agent:

1. **Projects** — Create or open a project (folder on the server)
2. **Workspaces** — For git repos, create worktrees; for non-git folders, use the project directly
3. **Sessions** — Start chat sessions with Pi Coding Agent inside a workspace

All chat history and session data persists in the `pi-data` Docker volume at `~/.pi/sessions`.

Use `/tools state` to see available tools, `/tools toggle <name>` to enable/disable tools, and other extension commands as needed.

#### Optional: llama-swap

llama-swap is an optional service for dynamic LLM model swapping. It is **disabled by default** and can be enabled in two ways:

**Option 1: Profile** (local llama-swap instance)
```bash
docker compose --profile llama-swap up
```

**Option 2: External URL** (remote llama-swap service)
```bash
LLAMA_SWAP_URL=https://ai.example.com docker compose up
```
When `LLAMA_SWAP_URL` is set, the work container will auto-trust the host in the proxy allowlist. Configure your pi models to point to this URL for dynamic model discovery.

### Health Monitoring

Docker healthchecks verify that all critical services are running:

**Work Container** (checked every 30s):
- ✅ Squid proxy listening on port 3128
- ✅ dnsmasq DNS resolver listening on port 53
- ✅ Pi Web session daemon socket exists
- ✅ Pi Web server listening on port 8504
- ✅ Supercronic scheduler process running

**SearXNG Container** (checked every 30s):
- ✅ HTTP endpoint responding on port 8080

View health status:
```bash
docker ps                        # Shows health status in output
docker inspect work --format='{{.State.Health.Status}}'
docker compose ps                # Shows health status for all services
```

If a service fails its healthcheck after 3 retries, Docker will restart the container automatically.

---

## Configuration reference

### Environment variables

| Variable              | Default               | Description                                                                             |
|-----------------------|-----------------------|-----------------------------------------------------------------------------------------|
| `NETWORK_MODE`        | `allowlist`           | `allowlist` — strict outbound control; `open-get` — all domains but GET/HEAD only       |
| `WORKSPACE_DIR`       | `./workspace`         | Host path mounted as `/workspace`                                                       |
| `CONFIG_DIR`          | `./config`            | Host path mounted as `/config`                                                          |
| `PI_WEB_PORT`         | `8504`                | Host port for the pi web UI                                                             |
| `SEARXNG_URL`         | `http://searxng:8080` | SearXNG endpoint (internal Docker URL); set to a custom URL for external SearXNG        |
| `URL_REWRITE_ENABLED` | `false`               | Enable optional URL query-string stripping in Mode B (uses `squid-url-rewrite.py`)      |
| `PROXY_ALLOWLIST`     | —                     | Newline-separated domains; overrides `config/proxy-allowlist.txt` at runtime            |
| `SUDO_ALLOWLIST`      | —                     | Newline-separated commands (without sudo prefix); overrides `config/sudo-allowlist.txt` at runtime       |
| `LLAMA_SWAP_URL`      | —                     | External llama-swap URL for dynamic model discovery (auto-adds host to proxy allowlist) |
| `GIT_CREDENTIAL_URLS` | —                     | Newline-separated full `.git-credentials` entries written at startup                      |
| `GIT_CREDENTIAL_PROTOCOL` | `https`          | Protocol used when assembling a single git credential entry                               |
| `GIT_CREDENTIAL_HOST` | —                     | Hostname for a single git HTTPS credential entry                                          |
| `GIT_CREDENTIAL_PATH` | —                     | Optional repo/path scope; enables `credential.useHttpPath=true`                           |
| `GIT_CREDENTIAL_USERNAME` | —                | Username for a single git HTTPS credential entry                                          |
| `GIT_CREDENTIAL_PASSWORD` | —                | Password or PAT for a single git HTTPS credential entry                                   |
| `ANTHROPIC_API_KEY`   | —                     | Anthropic API key                                                                       |
| `OPENAI_API_KEY`      | —                     | OpenAI API key                                                                          |

### config/proxy-allowlist.txt

One domain per line; subdomains are matched automatically.  Blank lines and `#` comments are ignored.  Used in Mode A (squid allowlist + dnsmasq default-deny).  Can be overridden at runtime via the `PROXY_ALLOWLIST` env var.

### config/sudo-allowlist.txt

One command per line without the `sudo` prefix.  Empty by default.  At container startup, the entrypoint converts this file into `/etc/sudoers` Cmnd_Alias directives, then makes `/etc/sudoers` immutable with `chattr +i` so the agent cannot modify sudo permissions.  Commands not listed here are blocked by sudo itself.  Can be overridden at runtime via the `SUDO_ALLOWLIST` env var.

### config/searxng-settings.yml

SearXNG configuration file.  Defines enabled search engines, safe-search level, and server settings.  Mounted read-only into the searxng container.

### config/llama-swap.yml

llama-swap configuration file.  Empty by default — llama-swap uses its own defaults.  Only needed when running llama-swap via `--profile llama-swap`.

---

## pi extensions

### Local extensions (bundled)

| Extension       | File                       | Purpose                                                                                                          |
|-----------------|----------------------------|------------------------------------------------------------------------------------------------------------------|
| `pi-network-mode` | `extensions/network-mode.ts` | `network_mode` tool + `/network` command for runtime sandbox mode switching (`allowlist` / `open-get`)         |
| `pi-tools`      | `extensions/tools.ts`      | `/tools` command; runtime enable/disable of individual tools; persists selection                                 |
| `pi-scheduler`  | `extensions/scheduler.ts`  | `/task` command and tool; manage scheduled tasks via supercronic (cron for containers); persists to crontab file |
| `pi-todo`       | `extensions/todo.ts`       | `todo` tool; persistent todo list (add / complete / delete / list)                                               |
| `pi-llama-swap` | `extensions/llama-swap.ts` | Llama-swap dynamic model discovery; enables `/swap` command for runtime model switching                          |

### Off-the-shelf extensions (loaded via `package.json` → `pi install`)

| Extension            | Pinned Version | Purpose                                 |
|----------------------|----------------|-----------------------------------------|
| `@jmfederico/pi-web` | `1.202606.0`   | Web browsing extension                  |
| `pi-searxng`         | `1.0.4`        | SearXNG search integration              |
| `pi-drawio`          | `0.1.0`        | Draw.io diagram editor                  |
| `pi-wiki`            | `2.0.0`        | Wikipedia search                        |
| `pi-lens`            | `3.8.44`       | Code lens / language server integration |
| `pi-subagents`       | `0.24.2`       | Spawn sub-agent sessions                |
| `pi-lama-swap`       | `0.1.0`        | Llama-swap model discovery integration  |

### Commands

Custom commands provided by local extensions:

| Command  | Extension      | Usage                                       | Description                                                    |
|----------|----------------|---------------------------------------------|----------------------------------------------------------------|
| `/network` | `pi-network-mode` | `/network state`                         | Show the current runtime network mode and active squid/dnsmasq configs |
|          |                | `/network switch <allowlist|open-get>`      | Switch network mode at runtime without restarting the container |
| `/tools` | `pi-tools`     | `/tools state`                              | Show all tools and their enabled/disabled state                |
|          |                | `/tools toggle <name>`                      | Toggle a specific tool on or off                               |
|          |                | `/tools set <name1,name2,...>`              | Enable only the specified tools, disable all others            |
| `/task`  | `pi-scheduler` | `/task schedule <name> <prompt> [interval]` | Create a scheduled task (interval: 5m, 2h, 1d, or cron syntax) |
|          |                | `/task list`                                | Show all scheduled tasks                                       |
|          |                | `/task delete <name>`                       | Remove a scheduled task                                        |

### Session persistence

Session data is stored in `.pi/agents/sessions` (configured via `.pi/settings.json` → `sessionDir`).  The directory is bind-mounted from the host into the container so it persists across container rebuilds.

### Scheduler

The scheduler extension uses [supercronic](https://github.com/aptible/supercronic) to manage scheduled agent tasks. Tasks are stored in `/workspace/.scheduler.crontab` and persist across container restarts.

#### Creating scheduled tasks

**Simple tasks (via command):**
```bash
# Human-readable intervals (converted to cron)
/task schedule hourly-check "Check system status" 1h
/task schedule daily-report "Generate daily report" 1d
/task schedule frequent "Quick check" 5m

# Cron syntax for advanced scheduling
/task schedule nightly "Run backup" "0 2 * * *"  # 2 AM daily
/task schedule weekday "Weekday task" "0 9 * * 1-5"  # 9 AM Mon-Fri
```

**Advanced tasks (via `scheduler_task` tool):**

For tasks requiring prompt files, tool restrictions, skills, custom models, or ephemeral sessions, use the `scheduler_task` tool:

```javascript
// Task with prompt file
scheduler_task({
  action: "schedule",
  name: "daily-report",
  promptFile: "tasks/daily_report_prompt.md",
  interval: "1d"
})

// Task with restricted tools and custom model
scheduler_task({
  action: "schedule",
  name: "readonly-audit",
  prompt: "Audit the codebase for security issues",
  tools: ["read", "grep", "find", "ls"],
  model: "sonnet",
  interval: "12h"
})

// Task with skills and ephemeral session
scheduler_task({
  action: "schedule",
  name: "notification-check",
  promptFile: "tasks/check_and_notify.md",
  skills: ["notify", "scheduled-tasks"],
  ephemeralSession: true,
  interval: "1h"
})
```

**Prompt options:**
- **`prompt`**: Inline string (max 500 characters). Newlines are automatically converted to spaces.
- **`promptFile`**: Path to a file containing the prompt (workspace-relative or absolute). Passed to pi via `@filename` syntax.
- **`tools`**: Array of allowed tool names (e.g., `["read", "grep", "find"]`)
- **`skills`**: Array of skill names (e.g., `["notify", "scheduled-tasks"]`). Skills are loaded from `~/.pi/agent/skills/`.
- **`model`**: Model pattern or ID (e.g., `"sonnet"`, `"gpt-4o"`)
- **`ephemeralSession`**: Don't save session to disk (useful for recurring tasks that don't need history)

#### How it works

1. **Command:** Use `/task schedule` for simple tasks, or `scheduler_task` tool for advanced features
2. **Storage:** Task metadata stored as comments in `/workspace/.scheduler.crontab`
3. **Execution:** Supercronic monitors the crontab and runs `pi --mode print` with configured options at scheduled times
4. **Isolation:** Each task runs in an isolated agent session

#### Viewing and managing tasks

```bash
/task list                    # Show all tasks with schedules and options
/task delete hourly-check     # Remove a task
```

The crontab file can also be inspected directly at `/workspace/.scheduler.crontab` for debugging.

### Skills

Skills are loaded from `skills/` (declared in `package.json` → `pi.skills`) and copied into the container at `~/.pi/agent/skills/` for global discovery.

| Skill             | Location                  | Purpose                                                                      |
|-------------------|---------------------------|------------------------------------------------------------------------------|
| `notify`          | `skills/notify/`          | Send push notifications via ntfy.sh for background-triggered events          |
| `scheduled-tasks` | `skills/scheduled-tasks/` | "explainer" on how to properly use the `scheduler.ts` extension's toolset    |

---

## Network modes in detail

### Mode A — Allowlist (default)

- Squid listens on port 3128, accepts only `CONNECT` to allowlisted domains.
- dnsmasq returns `0.0.0.0` for all domains by default; only allowlisted domains receive real DNS lookups (forwarded to upstream resolver from container's original resolv.conf).
- Designed to prevent bulk data exfiltration and DNS-based exfiltration.

### Mode B — Open-GET

- Squid performs TLS interception (SSL bump) using a build-time self-signed CA injected into the container's trust store.
- Only `GET` and `HEAD` methods are forwarded; all others return `403`.
- All request headers except a small safe set (`Host`, `Accept`, `Accept-Language`, `Accept-Encoding`, `User-Agent`, `Cache-Control`) are stripped.
- Query strings are removed from all URLs before forwarding (optional, enabled via `URL_REWRITE_ENABLED=true`).
- dnsmasq forwards all queries upstream.
- Designed for read-only browsing/research with reduced header leakage.

### Runtime mode switching

The sandbox mode can be changed while the container is running:

- Tool: `network_mode`
  - `{"action":"status"}`
  - `{"action":"set","mode":"allowlist"}`
  - `{"action":"set","mode":"open-get"}`
- Command: `/network state` and `/network switch <allowlist|open-get>`

Implementation notes:

- Privileged changes are delegated to `/usr/local/bin/network-mode` via sudo (explicitly allowlisted in `config/sudo-allowlist.txt`).
- The script re-renders runtime dnsmasq/squid configs, validates them, restarts dnsmasq, and reconfigures squid in place.
- Current mode is persisted to `/run/work/network-mode` and `/run/work/network-state.json`.
- The `system-prompt` extension reads runtime mode state on each `before_agent_start`, so prompt injection always reflects the active mode.

---

## Development

See [AGENTS.md](AGENTS.md) for coding conventions and testing checklist.
