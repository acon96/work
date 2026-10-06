#!/usr/bin/env bash
# entrypoint.sh - container start-up, running as the unprivileged agent user.
#
#   1. Prepare scheduler state
#   2. Configure git credentials
#   3. Start the pi-web session daemon and supercronic
#   4. Exec the pi web server
#
# There is no proxy, DNS, firewall, sudoers, CA-bundle, or privilege-dropping
# work in this script. Outbound policy is enforced per-Bash-command by the
# pi-sandbox extension, and tool-level policy by pi-permission-system.
set -euo pipefail

AGENT_HOME="/home/agent"
AGENT_GITCONFIG="$AGENT_HOME/.gitconfig"
AGENT_GIT_CREDENTIALS="$AGENT_HOME/.git-credentials"

log() { echo "[entrypoint] $*"; }

urlencode() {
    jq -nr --arg value "$1" '$value|@uri'
}

configure_git_credentials() {
    local helper_mode=""
    local use_http_path="false"
    local credential_entry=""

    if [[ -n "${GIT_CREDENTIAL_URLS:-}" ]]; then
        log "Configuring git credentials from GIT_CREDENTIAL_URLS"
        printf '%s\n' "$GIT_CREDENTIAL_URLS" > "$AGENT_GIT_CREDENTIALS"
        helper_mode="store"
    elif [[ -n "${GIT_CREDENTIAL_HOST:-}" && -n "${GIT_CREDENTIAL_USERNAME:-}" && -n "${GIT_CREDENTIAL_PASSWORD:-}" ]]; then
        log "Configuring git credentials for host ${GIT_CREDENTIAL_HOST}"

        credential_entry="${GIT_CREDENTIAL_PROTOCOL:-https}://$(urlencode "$GIT_CREDENTIAL_USERNAME"):$(urlencode "$GIT_CREDENTIAL_PASSWORD")@${GIT_CREDENTIAL_HOST}"
        if [[ -n "${GIT_CREDENTIAL_PATH:-}" ]]; then
            credential_entry+="/${GIT_CREDENTIAL_PATH#/}"
            use_http_path="true"
        fi

        printf '%s\n' "$credential_entry" > "$AGENT_GIT_CREDENTIALS"
        helper_mode="store"
    fi

    if [[ -n "$helper_mode" ]]; then
        chmod 0600 "$AGENT_GIT_CREDENTIALS"
        git config --file "$AGENT_GITCONFIG" credential.helper "$helper_mode"
        git config --file "$AGENT_GITCONFIG" credential.useHttpPath "$use_http_path"
    fi
}

# -- scheduler crontab --------------------------------------------------------
# Create scheduler crontab and state under a dedicated persisted pi agent directory.
# Defaults to /home/agent/.pi/scheduled.
touch "$SCHEDULER_STATE_DIR/history.jsonl"
touch "$SCHEDULER_STATE_DIR/scheduler.crontab"

# -- git credentials ----------------------------------------------------------
# A root-mediated helper is not meaningfully secret from the agent: anything
# the agent can use via git, it can also trigger directly. For HTTPS auth we
# therefore support explicit startup injection into git's standard store.
configure_git_credentials

# -- render network policy -------------------------------------------------------
# Pristine policy copies are baked into the image under /etc/work/policies
# (root-owned, read-only to the agent). The effective configs are always
# re-rendered from them at startup, so restarts are idempotent and env var
# edits fully replace prior values instead of accumulating. The only runtime
# policy knobs are PROXY_ALLOWLIST and SSRF_ALLOW_RANGES below; anything else
# means editing config/ in the repo and rebuilding the image.
POLICY_SRC="/etc/work/policies"
SANDBOX_CONFIG="$AGENT_HOME/.pi/agent/extensions/pi-sandbox/config.json"
PERMISSION_CONFIG="$AGENT_HOME/.pi/agent/extensions/pi-permission-system/config.json"
WEB_SEARCH_CONFIG="$AGENT_HOME/.pi/agent/web-search.json"

for pair in \
    "pi-sandbox-config.json:$SANDBOX_CONFIG" \
    "pi-permission-system-config.json:$PERMISSION_CONFIG" \
    "web-search.json:$WEB_SEARCH_CONFIG"; do
    src="$POLICY_SRC/${pair%%:*}"
    dest="${pair#*:}"
    if [ -f "$src" ]; then
        cp "$src" "$dest.tmp" && mv "$dest.tmp" "$dest"
    fi
done

# PROXY_ALLOWLIST: comma-separated domains appended to the pi-sandbox
# silent baseline (legacy name kept for continuity with the squid era).
if [ -n "${PROXY_ALLOWLIST:-}" ]; then
    log "Merging PROXY_ALLOWLIST domains into the pi-sandbox baseline"
    tmp="$(mktemp)"
    jq --arg list "$PROXY_ALLOWLIST" '
        .network = (.network // {}) |
        .network.allowedDomains = ((.network.allowedDomains // [])
            + ($list | split(",")
                  | map(gsub("^[[:space:]]+|[[:space:]]+$"; ""))
                  | map(select(. != "")))
            | unique)
    ' "$SANDBOX_CONFIG" > "$tmp"
    mv "$tmp" "$SANDBOX_CONFIG"
fi

# SSRF_ALLOW_RANGES: comma-separated CIDRs appended to pi-web-access's
# ssrf.allowRanges. Only needed when the SearXNG endpoint (or another
# intended fetch target) resolves to a private address; public endpoints
# need no exception.
if [ -n "${SSRF_ALLOW_RANGES:-}" ]; then
    log "Merging SSRF_ALLOW_RANGES into the pi-web-access SSRF guard"
    tmp="$(mktemp)"
    jq --arg list "$SSRF_ALLOW_RANGES" '
        .ssrf = (.ssrf // {}) |
        .ssrf.allowRanges = ((.ssrf.allowRanges // [])
            + ($list | split(",")
                  | map(gsub("^[[:space:]]+|[[:space:]]+$"; ""))
                  | map(select(. != "")))
            | unique)
    ' "$WEB_SEARCH_CONFIG" > "$tmp"
    mv "$tmp" "$WEB_SEARCH_CONFIG"
fi

# -- pi-web: keep the bundled relays package disabled ----------------------------
# pi-web sessiond auto-installs "known" Pi packages (currently
# @jmfederico/pi-relay) from its own tarball into the agent profile at startup,
# unless the package has been dismissed. This deployment deliberately does not
# use relays, so record the dismissal (idempotent). The image also removes the
# shipped package source (see Dockerfile) as defense-in-depth.
AGENT_PROFILE_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
DISMISSALS_FILE="${PI_WEB_PI_PACKAGE_DISMISSALS_FILE:-$PI_WEB_DATA_DIR/pi-package-dismissals.json}"
mkdir -p "$(dirname "$DISMISSALS_FILE")"
if [ ! -f "$DISMISSALS_FILE" ]; then
    jq -n --arg profileDir "$AGENT_PROFILE_DIR" --arg dismissedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{dismissals: [{profileDir: $profileDir, packageId: "@jmfederico/pi-relay", dismissedAt: $dismissedAt}]}' \
        > "$DISMISSALS_FILE"
    log "Dismissed auto-installable Pi package @jmfederico/pi-relay for profile $AGENT_PROFILE_DIR"
fi

# -- pi-web: ensure socket is free ---------------------------------------------------
# The pi-web session daemon will create a Unix socket at $PI_WEB_SESSIOND_SOCKET.
SESSIOND_SOCKET_DIR="$(dirname "$PI_WEB_SESSIOND_SOCKET")"
mkdir -p "$SESSIOND_SOCKET_DIR"
rm -f "$PI_WEB_SESSIOND_SOCKET" 2>/dev/null || true

# Run directly (not inside sh -c) so SESSIOND_PID is the daemon PID.
log "Starting pi-web session daemon"
env PI_WEB_DATA_DIR="$PI_WEB_DATA_DIR" PI_WEB_SESSIOND_SOCKET="$PI_WEB_SESSIOND_SOCKET" pi-web-sessiond &
SESSIOND_PID=$!

# Wait until the session daemon socket is ready.
for i in $(seq 1 20); do
    if [ -S "$PI_WEB_SESSIOND_SOCKET" ]; then
        log "Pi-web session daemon is ready."
        break
    fi
    sleep 0.5
done

# -- start supercronic (scheduler) --------------------------------------------
# Supercronic monitors the scheduler crontab and executes tasks as the agent user.
log "Starting supercronic (crontab: $SCHEDULER_CRONTAB_PATH)"
supercronic -inotify "$SCHEDULER_CRONTAB_PATH" &
SUPERCRONIC_PID=$!

# -- exec the pi server -------------------------------------------------------
log "Handing off to pi server as uid $(id -u)"
exec "$@"
