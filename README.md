# work

A hardened Docker sandbox for "light" agentic development and research tasks, powered by [pi](https://pi.dev).  Feel free to fork and adapt for your own needs. Just update `package.json` with new extensions and skills, and add any necessary OS-level dependencies to the Dockerfile. Merging to `main` pushes a new `docker` image to GHCR for easy use.

---

## Architecture overview

```mermaid
graph TB
    subgraph compose["Container deployment"]
        subgraph workc["work container (Node 24 LTS, uid 1001, no root/sudo)"]
            pi["Pi Web + session daemon + Pi<br/>(user: agent)"]
            ps["pi-sandbox: every Bash command runs in a<br/>bubblewrap jail: own netns, workspace-scoped writes,<br/>domain allowlist enforced by the sandbox broker"]
            perm["pi-permission-system: human-prompt gates on<br/>file tools + out-of-CWD access, secrets denied"]
        end
        searxng["SearXNG<br/>same network"]
        llama["llama-swap<br/>same network"]
        net["agent-net bridge<br/>172.28.0.0/24"]

        pi --> ps
        pi --> perm
        pi --- net
        searxng --- net
        llama --- net
    end

    browser(("browser")) -->|"Pi Web on host loopback"| pi

    ps -->|"allowlisted hosts only"| internet((Internet))
    pi -->|"model/API egress (not OS-sandboxed)"| internet
    searxng -->|own searches| internet
```

### Security layers

| Layer          | Mechanism                                                                   | Blocks                                                                                                     |
|----------------|------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| OS sandbox     | pi-sandbox wraps every Bash tool call in bubblewrap (mount + network namespaces, seccomp) | Bash writes outside the workspace; reads outside allowed regions; any network connection to non-allowlisted hosts |
| Network        | pi-sandbox policy (`config/pi-sandbox-config.json`): static allow + per-connection human prompt | Direct sockets, DNS, and raw connections from sandboxed Bash; every non-baseline destination needs a human click |
| Tool policy    | pi-permission-system allow/ask/deny with human prompts only (no authorizerChain) | Pi's native read/write/edit reaching outside the CWD; access to `.env`, keys, credentials, and the security configs themselves |
| Network        | The Pi Web UI port is published on the host loopback only (`PI_WEB_BIND_ADDRESS=127.0.0.1`)   | Remote access to the agent's UI; any route the agent could gain through its UI port        |
| OS             | uid/gid 1001, no sudo, no root, `cap_drop: ALL`, `no-new-privileges`         | Privilege escalation and OS package installation                                                              |
| Runtime        | Health probes verify bwrap can create sandboxes, plus Pi Web and supercronic liveness | Silent loss of the sandbox substrate: a node that breaks user namespaces turns the stack unhealthy |

Trust model (changed by the Squid removal): network enforcement moved from
"infrastructure the agent cannot bypass" (separate proxy container,
internal-only networks) to "extension that must be correctly loaded"
(pi-sandbox). The Pi process itself is not OS-sandboxed -- its model calls and
fetch tools use the container's normal egress. Sandbox integrity is verified
by the container healthcheck, and the policy files are read-only bind mounts
that both extensions also write-protect. The equivalent Kubernetes controls
are a permissive-enough seccomp/AppArmor posture for user namespaces on the
node, plus the same read-only config mounts.

---

## Quick start

### Prerequisites

- Docker ≥ 24
- Docker Compose v2

### 1. Build the image

One image is built: the agent (`work-sandbox`). pi-sandbox and its native
helpers (bubblewrap, socat, ripgrep) are baked in.

```bash
docker compose build
```

Or pull the pre-built image (published by CI):

```bash
docker pull ghcr.io/<owner>/work:main
```

### 2. Configure

Edit `config/pi-sandbox-config.json` -> `network.allowedDomains` to change the
domains Bash may reach without prompting. Entries are exact domains,
subdomain wildcards (`*.example.com`), and optional `:port` restrictions.

The sandbox broker only evaluates public hostnames, so local service names
(`searxng`, `llama-swap`) cannot be allowlisted; reach them through Pi's own
tools (web_search, fetch_content, model providers), which run outside the Bash
jail and are gated by pi-permission-system instead.

### 3. Run

The default Compose topology mirrors the production deployment: search and
llama-swap are external services, only mutable runtime state is persisted, and
Pi Web is published on host loopback. Configure public-safe example endpoints
through `.env` and start the container:
```bash
SEARXNG_BASE_URL=https://search.example.com \
LLAMA_SWAP_URL=https://ai.example.com \
docker compose up
```

For a self-contained development stack, enable the optional local llama-swap
service and point the agent at the Compose service names (Pi tools reach them;
sandboxed Bash does not):

```bash
SEARXNG_BASE_URL=http://searxng:8080 \
LLAMA_SWAP_URL=http://llama-swap:8080 \
docker compose --profile llama-swap up
```

Production credentials should be supplied by the deployment platform. The
public Compose file deliberately does not define repository-specific secret
names. It mounts ignored `./secrets/git` and `./secrets/wiki` directories at
the same generic in-container paths as the Kubernetes Secret volumes. Override
their host locations with `GIT_SECRET_DIR` and `WIKI_SECRET_DIR`.

The agent container runs three processes as uid 1001:

- **Pi Web** — Web UI and session daemon (port 8504)
- **Supercronic** — Cron scheduler for background tasks
- **Pi sessions** — spawned by the session daemon

Outbound HTTP/HTTPS from the Pi process uses the shared `agent-net` network
directly; outbound from sandboxed Bash commands goes only through the
pi-sandbox broker's policy proxy. SearXNG and llama-swap are reached on the
same network.

Open the Pi Web UI at **http://127.0.0.1:8504**. Local SearXNG, when enabled,
is reachable from the agent at **http://searxng:8080**.

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

Chat history and session data persist in the `.pi/agent/sessions` directory on
the host, bind-mounted into the container. The `work` container publishes the
Pi Web port on the host loopback only; do not widen `PI_WEB_BIND_ADDRESS` --
pi-web itself is not a permission boundary, tool gating is.

Use `/tools state` to see available tools, `/tools toggle <name>` to enable/disable tools, and other extension commands as needed.

#### Optional: llama-swap

llama-swap is external by default. A local service is optional and disabled by default:

**Option 1: Local service**
```bash
SEARXNG_BASE_URL=http://searxng:8080 \
LLAMA_SWAP_URL=http://llama-swap:8080 \
docker compose --profile llama-swap up
```

**Option 2: External URL** (remote llama-swap service)
```bash
LLAMA_SWAP_URL=https://ai.example.com docker compose up
```
When `LLAMA_SWAP_URL` names a **remote** host, add it to
`config/pi-sandbox-config.json` -> `allowedDomains` if Bash commands need to
reach it. A local service name (no dot) is unreachable from sandboxed Bash.
Configure your pi models to point to this URL for dynamic model discovery.

### Health Monitoring

Docker healthchecks verify that all critical services are running:

**Work Container** (checked every 30s):
- ✅ bwrap can create a sandbox (`bwrap --ro-bind / / --unshare-all --share-net true`) -- if this fails, pi-sandbox is silently degraded and the stack is UNHEALTHY
- ✅ Pi Web session daemon socket exists and answers `/health`
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

Sandbox decisions are made by the pi-sandbox broker inside the agent
container; its activity surfaces in the session (denied tool calls) and in the
container logs. To confirm what policy is in force, read the mounted policy
file:

```bash
docker compose exec work cat /home/agent/.pi/agent/extensions/pi-sandbox/config.json
```

In Kubernetes, the liveness probe restarts the failed container. Docker Compose
reports an unhealthy status; its restart policy only acts when the container
process exits, not merely when a healthcheck fails.

---

## Configuration reference

### Environment variables

| Variable              | Default               | Description                                                                             |
|-----------------------|-----------------------|-----------------------------------------------------------------------------------------|
| `WORKSPACE_DIR`       | `./agent-workspace`   | Host path mounted as `/workspace`                                                       |
| `PI_WEB_PORT`         | `8504`                | Host port for the pi web UI, published by the `work` service on the host loopback          |
| `PI_WEB_BIND_ADDRESS` | `127.0.0.1`           | Host interface the UI port is published on; set to `0.0.0.0` to expose it on the LAN       |
| `PI_WEB_HOST`         | `0.0.0.0`             | Address pi-web binds **inside** the agent container; keep `0.0.0.0` so the published port can reach it |
| `SEARXNG_BASE_URL`    | `http://searxng:8080` | SearXNG endpoint for pi-web-access `web_search`; set to an external instance to skip the local one |
| `LLAMA_SWAP_URL`      | `https://ai.example.com` | llama-swap URL for dynamic model discovery; a local service name is reached directly     |
| `PI_TITLE_MODEL`      | `llama-swap/little-titles` | Model used to generate session titles                                               |
| `PI_SANDBOX_CONFIG`   | `/home/agent/.pi/agent/extensions/pi-sandbox/config.json` | Path the system-prompt extension reads to describe the active network policy |
| `GIT_SECRET_DIR`      | `./secrets/git`       | Host directory mounted read-only at `/etc/secrets/git`                                  |
| `WIKI_SECRET_DIR`     | `./secrets/wiki`      | Host directory mounted read-only at `/etc/secrets/wiki`                                 |
| `GIT_CREDENTIAL_URLS` | —                     | Newline-separated full `.git-credentials` entries written at startup                      |
| `GIT_CREDENTIAL_PROTOCOL` | `https`          | Protocol used when assembling a single git credential entry                               |
| `GIT_CREDENTIAL_HOST` | —                     | Hostname for a single git HTTPS credential entry                                          |
| `GIT_CREDENTIAL_PATH` | —                     | Optional repo/path scope; enables `credential.useHttpPath=true`                           |
| `GIT_CREDENTIAL_USERNAME` | —                | Username for a single git HTTPS credential entry                                          |
| `GIT_CREDENTIAL_PASSWORD` | —                | Password or PAT for a single git HTTPS credential entry                                   |
| `ANTHROPIC_API_KEY`   | —                     | Anthropic API key                                                                       |
| `OPENAI_API_KEY`      | —                     | OpenAI API key                                                                          |

### config/pi-sandbox-config.json

pi-sandbox policy. Installed read-only at `~/.pi/agent/extensions/pi-sandbox/config.json`. The parser rejects unknown keys (fail closed), so the file contains no comments -- rationale lives here in the README. `network.allowedDomains` is the silent baseline (exact domains, `*.example.com` subdomain wildcards, optional `:port`); everything else prompts the human in the session UI once per connection. `subagents.provider: "off"` keeps subagent execution disabled; `hostIPC.mode: "off"` keeps host execution out of the picture. The model-backed reviewer (`pi-auto-review`) is NOT enabled -- with no reviewer broker registered, pi-sandbox falls through to its built-in interactive approval. Sandboxed commands cannot write this file (pi-sandbox write-protects it); edit on the host, new sessions pick up changes. No container restart needed.

### config/pi-permission-system-config.json

pi-permission-system policy. Installed read-only at `~/.pi/agent/extensions/pi-permission-system/config.json`. No `authorizerChain` is configured, so every `ask` is an interactive human prompt in the session UI; no model-backed reviewer ever runs. `external_directory: "ask"` gates out-of-CWD file access; the `path` deny block protects `.env`, keys, git credentials, and the security configs themselves.

### config/web-search.json

pi-web-access policy. Installed read-only at `~/.pi/agent/web-search.json`.
`webSearch.allowedProviders: ["searxng"]` pins search to the configured SearXNG
endpoint (`SEARXNG_BASE_URL`) with no fallback to hosted search providers.
`ssrf.allowRanges` exempts only the internal SearXNG container address
(`172.28.0.10/32`, pinned in docker-compose.yml) from the SSRF guard, which
otherwise blocks loopback and private targets for `fetch_content`. On
Kubernetes, set this to the SearXNG pod IP (or a dedicated range) so search can still reach it.

### config/searxng-settings.yml

SearXNG configuration file.  Defines enabled search engines, safe-search level, and server settings.  Mounted read-only into the searxng container.

### config/llama-swap.yml

llama-swap configuration file. Defines health check timeouts, log levels, server
macros, and context-length shortcuts. Mounted read-only into the local
llama-swap container when running with `--profile local-services`.

### config/agent.gitconfig

Default git configuration for the `agent` user.  Copied into the container at `/home/agent/.gitconfig`.  Git credential settings are applied at startup via the `GIT_CREDENTIAL_*` environment variables.

---

## pi extensions

### Local extensions (bundled)

| Extension        | File                         | Purpose                                                                                                          |
|------------------|------------------------------|------------------------------------------------------------------------------------------------------------------|
| `pi-system-prompt` | `extensions/system-prompt.ts` | Injects sandbox environment details (active pi-sandbox allowlist, permission gates) into the agent system prompt |
| `pi-tools`         | `extensions/tools.ts`         | `/tools` command; runtime enable/disable of individual tools; persists selection                                  |
| `pi-scheduler`     | `extensions/scheduler.ts`     | `/task` command and tool; manage scheduled tasks via supercronic (cron for containers); persists to crontab file  |
| `pi-todo`          | `extensions/todo.ts`          | `todo` tool; persistent todo list (add / complete / delete / list)                                               |
| `pi-llama-swap`    | `extensions/llama-swap.ts`    | Llama-swap dynamic model discovery; field mapping from llama-swap metadata to pi model config                    |
| `pi-superagent`    | `extensions/superagent.ts`    | Weak-model-gathers, strong-model-plans hybrid; single strong-model call for strategic planning                   |

### Off-the-shelf extensions (loaded via `package.json` dependencies + `packages` in settings)

| Extension                        | Pinned Version | Purpose                                         |
|----------------------------------|----------------|-------------------------------------------------|
| `@earendil-works/pi-coding-agent` | `1.0.4`        | Pi Coding Agent core (SDK + runtime), pi 1.x    |
| `@jmfederico/pi-web`             | `1.202610.1`   | Web UI and session daemon (pi 1.x peers)        |
| `@erichll/pi-sandbox`            | `0.24.0`       | bubblewrap sandboxing of Bash: network + filesystem policy (pi 1.x) |
| `@gotgenes/pi-permission-system` | `39.1.0`       | allow/ask/deny gates on tools and paths, human prompts only (pi 1.x) |
| `pi-web-access`                  | `0.36.0`       | `web_search`, `fetch_content`, `get_search_content`, `source_check`; SearXNG-first, built-in SSRF guard (pi 1.x) |
| `pi-lens`                        | `3.8.71`       | Code lens / language server integration. **Not pi 1.x-ready**: latest release (4.3.0) still peers on pi-tui 0.84/0.85; loads an old bundled pi-tui. Drop or watch upstream |

### Commands

Custom commands provided by local extensions:

| Command       | Extension         | Usage                                       | Description                                                    |
|---------------|-------------------|---------------------------------------------|----------------------------------------------------------------|
| `/tools`      | `pi-tools`        | `/tools state`                              | Show all tools and their enabled/disabled state                |
|               |                   | `/tools toggle <name>`                      | Toggle a specific tool on or off                               |
|               |                   | `/tools set <name1,name2,...>`              | Enable only the specified tools, disable all others            |
| `/task`       | `pi-scheduler`    | `/task schedule <name> <prompt> [interval]` | Create a scheduled task (interval: 5m, 2h, 1d, or cron syntax) |
|               |                   | `/task list`                                | Show all scheduled tasks                                       |
|               |                   | `/task delete <name>`                       | Remove a scheduled task                                        |
| `/superagent` | `pi-superagent`   | `/superagent models`                        | List all available models for planning                         |
|               |                   | `/superagent providers`                     | List configured providers and auth status                      |

### Session persistence

Compose persists session, Pi Web, and scheduler state in the `work-sessions`,
`work-web`, and `work-scheduled` named volumes. Global settings and models remain
image-owned, matching the Kubernetes deployment. Kubernetes mounts the three
state directories from dedicated PVC subpaths.

### Scheduler

The scheduler extension uses [supercronic](https://github.com/aptible/supercronic) to manage scheduled agent tasks. Scheduler state defaults to `/home/agent/.pi/scheduled` (intended for a dedicated persistent mount), including the crontab and execution history.

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
2. **Storage:** Task metadata stored as comments in `/home/agent/.pi/scheduled/scheduler.crontab`
3. **Execution:** Supercronic monitors the crontab and invokes a wrapper that runs `pi -p` with configured options at scheduled times
4. **Isolation:** Each task runs in an isolated agent session

#### Viewing and managing tasks

```bash
/task list                    # Show all tasks with schedules and options
/task delete hourly-check     # Remove a task
```

The crontab file can also be inspected directly at `/home/agent/.pi/scheduled/scheduler.crontab` for debugging.

#### Execution history and debugging

Each scheduled invocation is recorded under scheduler state:

```text
/home/agent/.pi/scheduled/history.jsonl
/home/agent/.pi/scheduled/<run-id>/metadata.json
/home/agent/.pi/scheduled/<run-id>/stdout.log
/home/agent/.pi/scheduled/<run-id>/stderr.log
```

The local **Scheduled runs** PI WEB panel shows run status, duration, exit code, a basic failure classification, and captured stdout/stderr. Select a run to inspect its logs. Scheduler output is ignored by git because agent output can contain workspace-derived or prompt-derived content.

The wrapper retains the most recent 200 run directories by default. Set `SCHEDULER_HISTORY_MAX_RUNS` to change that number, or set it to `0` to disable pruning. The JSONL index is append-only, so rows whose logs have been pruned can remain in the index.

After building the image, reload the PI WEB browser tab so it discovers the seeded `scheduler-history` local plugin. The entrypoint does not overwrite a user-managed copy in the persistent PI WEB directory.

### Skills

Skills are loaded from `skills/` (declared in `package.json` → `pi.skills`) and copied into the container at `~/.pi/agent/skills/` for global discovery.

| Skill            | Location               | Purpose                                                                        |
|------------------|------------------------|--------------------------------------------------------------------------------|
| `notify`         | `skills/notify/`       | Send push notifications via ntfy.sh for background-triggered events            |
| `superagent`     | `skills/superagent/`   | Guide for invoking the superagent planning workflow with strong models         |

---

## Network policy in detail

### Sandbox network flow (pi-sandbox)

Every Bash tool invocation runs inside a bubblewrap sandbox with its own
mount and network namespaces. The sandbox's only network exit is the
pi-sandbox broker's policy proxy, which evaluates each connection against
`config/pi-sandbox-config.json`:

1. A matching `deniedDomains` entry rejects the connection.
2. Otherwise a matching `allowedDomains` entry permits it silently.
3. Otherwise the connection pauses and **the human is prompted in the session
   UI**: "Sandbox approval required: connect <host>:<port>" with
   "Allow this exact operation once" / "Deny". An approval applies to that
   one connection; a new connection to the same host prompts again.

This is the dynamic replacement for the old open-GET ("mode B") convenience:
new domains work immediately, but only a human clicking in the UI can open
them, and only once per connection. No file edit, no reload, and no container
restart is involved. Headless sessions (scheduler tasks) have no UI, so
unmatched destinations there are denied -- schedule against `allowedDomains`.

Filesystem side of the same jail: writes outside the current workspace fail
closed, reads outside allowed regions fail closed, common secrets (`.env`,
`*.pem`, `*.key`, ...) are write-denied inside the workspace, and each command
gets a private temp directory. The policy config itself is write-protected
against sandboxed commands.

`allowedDomains` is the silent baseline; keep it to the hosts used by
scheduled/headless tasks and high-frequency operations. Every allowlisted
domain is a potential exfiltration endpoint, so keep the list narrow.

The model-backed reviewer (`pi-auto-review`) ships as a dependency of
pi-sandbox but is deliberately never enabled as an extension: pi-sandbox
routes its network asks through a broker that only exists when pi-auto-review
is loaded, and with no broker it falls through to the interactive human
approval above. Do not add pi-auto-review to `packages` or to an
`authorizerChain`.

### Human review of tool actions (pi-permission-system)

pi-permission-system is the second gate and the only reviewer in this stack is
the human: no `authorizerChain` is configured, so no model-backed reviewer
(`pi-permission-model-judge`, `pi-auto-review`) ever runs.

- `external_directory: "ask"` -- any read/write/edit or Bash path outside the
  session's CWD prompts in the session UI. This is what enforces per-workspace
  folder usage for Pi's native file tools, which the Bash sandbox does not cover.
- `path` deny block -- `.env` variants, keys, `~/.ssh/*`, git credentials, and
  both security config files are denied across all tools at once, symlink-safe.
- Bash command patterns -- `deny` on `sudo` and `rm -rf /` patterns; everything
  else allowed (the OS sandbox governs what those commands can actually reach).

### Residual trust

Squid's removal moved enforcement from infrastructure to a pi extension:

- If pi-sandbox fails to load, Bash runs unsandboxed. Mitigations: the policy
  files are baked/bound read-only, `subagents.provider: "off"`, and the stack
  should be treated as unhealthy if the sandbox extension is missing.
- The Pi process itself (model calls, fetch tools, extensions) is not
  OS-sandboxed and has normal container egress.
- On Kubernetes, bwrap needs unprivileged user namespaces on the node
  (AppArmor: bwrap profile or `kernel.apparmor_restrict_unprivileged_userns=0`)
  and a seccomp profile that allows namespace creation. The container
  healthcheck fails if sandboxing is broken.

---

## Development

See [AGENTS.md](AGENTS.md) for coding conventions and testing checklist.
