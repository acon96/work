#!/usr/bin/env bash
# entrypoint.sh — container start-up:
#   1. Bootstrap /config files (allowlists, with env-var overrides)
#   2. Configure dnsmasq for the selected NETWORK_MODE
#   3. Configure squid for the selected NETWORK_MODE (with optional URL rewrite)
#   4. Copy local extensions to agent's .pi/extensions
#   5. Start dnsmasq and squid
#   6. Exec the pi server as the "work" user
set -euo pipefail

NETWORK_MODE="${NETWORK_MODE:-allowlist}"
CONFIG_DIR="/config"
WORK_CONFIG="/etc/work"
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
        chown agent:agent "$AGENT_GIT_CREDENTIALS"

        git config --file "$AGENT_GITCONFIG" credential.helper "$helper_mode"
        git config --file "$AGENT_GITCONFIG" credential.useHttpPath "$use_http_path"
        chown agent:agent "$AGENT_GITCONFIG"
    fi
}

# ── SSL cert generation (first-startup only) ──────────────────────────────────
# Generate a self-signed MITM CA at first boot so the private key is never
# baked into the image layers.  Injected into the system trust store so node
# processes running as agent trust it automatically.
SSL_FLAG="/etc/work/.ssl-initialized"
if [[ ! -f "$SSL_FLAG" ]]; then
    log "Generating self-signed SSL CA (first startup)"
    openssl req -new -newkey rsa:4096 -days 3650 -nodes -x509 \
        -subj "/CN=Work Proxy CA/O=Work Sandbox/C=US" \
        -keyout /etc/squid/ssl-ca.key \
        -out /etc/squid/ssl-ca.crt \
     && cp /etc/squid/ssl-ca.crt /usr/local/share/ca-certificates/work-proxy-ca.crt \
     && update-ca-certificates

    # Squid SSL certificate cache (Mode B) — must be owned by proxy user.
    # security_file_certgen -c creates the ssl_db directory itself; pre-creating it causes failure.
    /usr/lib/squid/security_file_certgen -c -s /var/lib/squid/ssl_db -M 4MB \
     && chown -R proxy:proxy /var/lib/squid/ssl_db

    touch "$SSL_FLAG"
    log "SSL CA generated and trusted."
else
    log "SSL CA already exists — skipping generation."
fi

# ── env-var allowlist overrides ──────────────────────────────────────────────
# PROXY_ALLOWLIST: comma-separated domains, appends to /config/proxy-allowlist.txt
if [[ -n "${PROXY_ALLOWLIST:-}" ]]; then
    log "Proxy allowlist provided via env var"
    IFS=',' read -ra DOMAINS <<< "$PROXY_ALLOWLIST"
    for domain in "${DOMAINS[@]}"; do
        echo "$domain" >> "$CONFIG_DIR/proxy-allowlist.txt"
    done
fi

# SUDO_ALLOWLIST: comma-separated commands (without sudo prefix), appends to /config/sudo-allowlist.txt
if [[ -n "${SUDO_ALLOWLIST:-}" ]]; then
    log "Sudo allowlist provided via env var"
    IFS=',' read -ra COMMANDS <<< "$SUDO_ALLOWLIST"
    for cmd in "${COMMANDS[@]}"; do
        echo "$cmd" >> "$CONFIG_DIR/sudo-allowlist.txt"
    done
fi

# ── generate restricted sudoers from allowlist ───────────────────────────────
# Convert /config/sudo-allowlist.txt into a restrictive /etc/sudoers that only
# permits the exact commands listed. Then make it immutable so the agent cannot
# modify sudo permissions at runtime.
log "Generating restricted sudoers from $CONFIG_DIR/sudo-allowlist.txt"

# Start with a minimal sudoers header
cat > /etc/sudoers <<'EOF'
# Generated from /config/sudo-allowlist.txt at container startup
# DO NOT EDIT — this file is made immutable via chattr +i
Defaults env_reset
Defaults mail_badpass
Defaults secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Root can do anything
root ALL=(ALL:ALL) ALL

# Agent user: restricted to allowlisted commands only
EOF

# Parse each line from the allowlist and convert to sudoers Cmnd_Alias + permission
if [[ -f "$CONFIG_DIR/sudo-allowlist.txt" ]]; then
    CMND_NUM=0
    CMND_ALIASES=()
    
    while IFS= read -r line; do
        # Skip comments and blank lines
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
        
        # Strip leading "sudo " prefix if present (for backward compatibility)
        cmd="${line#sudo }"
        cmd="${cmd#sudo}" # handle "sudo" with no space
        cmd=$(echo "$cmd" | xargs) # trim whitespace
        
        [[ -z "$cmd" ]] && continue
        
        CMND_NUM=$((CMND_NUM + 1))
        ALIAS_NAME="ALLOWED_CMD_${CMND_NUM}"
        CMND_ALIASES+=("$ALIAS_NAME")
        
        # Add Cmnd_Alias line
        echo "Cmnd_Alias $ALIAS_NAME = $cmd" >> /etc/sudoers
    done < "$CONFIG_DIR/sudo-allowlist.txt"
    
    # Add the agent user's permission line
    if [[ ${#CMND_ALIASES[@]} -gt 0 ]]; then
        ALIAS_LIST=$(IFS=', '; echo "${CMND_ALIASES[*]}")
        echo "agent ALL=(ALL) NOPASSWD: $ALIAS_LIST" >> /etc/sudoers
        log "Allowlisted ${#CMND_ALIASES[@]} sudo command(s) for agent user"
    else
        log "Warning: sudo allowlist is empty — agent has no sudo access"
        echo "agent ALL=(ALL) NOPASSWD: /usr/bin/false" >> /etc/sudoers
    fi
else
    log "Warning: $CONFIG_DIR/sudo-allowlist.txt not found — agent has no sudo access"
    echo "agent ALL=(ALL) NOPASSWD: /usr/bin/false" >> /etc/sudoers
fi

# Validate sudoers syntax
if ! visudo -c -f /etc/sudoers > /dev/null 2>&1; then
    log "ERROR: Generated sudoers file has syntax errors! Dumping for debug:"
    cat /etc/sudoers
    exit 1
fi

# Make sudoers immutable so the agent cannot modify it (defense-in-depth).
# This requires CAP_LINUX_IMMUTABLE; if it fails, continue anyway since the
# file is already protected by Unix permissions (root:root 0440, unwritable by agent).
if chattr +i /etc/sudoers 2>/dev/null; then
    log "sudoers is now immutable (chattr +i)"
else
    log "Warning: chattr +i failed (missing CAP_LINUX_IMMUTABLE); sudoers protected by file permissions only"
fi

# ── auto-trust LLAMA_SWAP_URL in proxy allowlist ─────────────────────────────
if [[ -n "${LLAMA_SWAP_URL:-}" ]]; then
    # Extract hostname (strip scheme, port, trailing slash)
    LS_HOST=$(echo "$LLAMA_SWAP_URL" | sed 's|.*://||' | sed 's|:.*||' | sed 's|/.*||')
    if [[ -n "$LS_HOST" ]] && ! grep -qx "$LS_HOST" "$CONFIG_DIR/proxy-allowlist.txt" 2>/dev/null; then
        log "Auto-trusting llama-swap host: $LS_HOST"
        echo "$LS_HOST" >> "$CONFIG_DIR/proxy-allowlist.txt"
    fi
fi

# ── resolv.conf ──────────────────────────────────────────────────────────────
# Save original upstream resolvers before we replace resolv.conf with
# 127.0.0.1 (needed by dnsmasq open mode).
cp /etc/resolv.conf /etc/resolv.conf.upstream 2>/dev/null || true
echo "nameserver 127.0.0.1" > /etc/resolv.conf

# ── scheduler crontab ────────────────────────────────────────────────────────
# Create empty crontab for scheduler extension if it doesn't exist
# Store in /workspace so it persists across container restarts
SCHEDULER_CRONTAB="/workspace/.scheduler.crontab"
if [[ ! -f "$SCHEDULER_CRONTAB" ]]; then
    touch "$SCHEDULER_CRONTAB"
    chown agent:agent "$SCHEDULER_CRONTAB"
    log "Created empty scheduler crontab at $SCHEDULER_CRONTAB"
fi

# ── git credentials ──────────────────────────────────────────────────────────
# A root-mediated helper is not meaningfully secret from the agent: anything
# the agent can use via git, it can also trigger directly. For HTTPS auth we
# therefore support explicit startup injection into git's standard store.
configure_git_credentials

# ── dnsmasq config ───────────────────────────────────────────────────────────
if [[ "$NETWORK_MODE" == "allowlist" ]]; then
    log "Network mode: allowlist"
    DNSMASQ_CONF="$WORK_CONFIG/dnsmasq-allowlist.conf"

    # Resolve the upstream DNS server from the saved resolv.conf so we never
    # hardcode a public resolver (e.g. 8.8.8.8).  server=/<domain>/<ip> must
    # carry an explicit IP because address=/#/0.0.0.0 takes precedence over
    # bare server=/<domain>/ directives in dnsmasq's resolution order.
    UPSTREAM_DNS=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf.upstream)
    if [[ -z "$UPSTREAM_DNS" ]]; then
        log "Warning: no upstream nameserver found in resolv.conf.upstream; DNS allowlist may not resolve"
    fi

    # Append per-domain server= directives from the allowlist so that
    # allowlisted domains bypass the address=/#/0.0.0.0 default-deny.
    RUNTIME_DNSMASQ="/run/dnsmasq-allowlist.conf"
    cp "$DNSMASQ_CONF" "$RUNTIME_DNSMASQ"
    while IFS= read -r domain; do
        [[ -z "$domain" || "$domain" =~ ^# ]] && continue
        echo "server=/${domain}/${UPSTREAM_DNS}" >> "$RUNTIME_DNSMASQ"
    done < "$CONFIG_DIR/proxy-allowlist.txt"
    DNSMASQ_CONF="$RUNTIME_DNSMASQ"
else
    log "Network mode: open-get"
    DNSMASQ_CONF="$WORK_CONFIG/dnsmasq-open.conf"
fi

# ── squid config ─────────────────────────────────────────────────────────────
if [[ "$NETWORK_MODE" == "allowlist" ]]; then
    SQUID_CONF="$WORK_CONFIG/squid-allowlist.conf"
else
    SQUID_CONF="$WORK_CONFIG/squid-open-get.conf"

    # ── optional URL rewrite for Mode B ──────────────────────────────────────
    if [[ "${URL_REWRITE_ENABLED:-false}" == "true" ]]; then
        log "URL rewrite enabled for Mode B"
        # Append url_rewrite directives to the config
        cat >> "$SQUID_CONF" <<'EOF'

# ── URL rewrite: strip query strings ──────────────────────────────────────
url_rewrite_program /usr/local/bin/squid-url-rewrite
url_rewrite_children 5 startup=1 idle=1
url_rewrite_concurrency 0
EOF
    fi
fi

# ── start dnsmasq ────────────────────────────────────────────────────────────
log "Starting dnsmasq (conf: $DNSMASQ_CONF)"
dnsmasq --conf-file="$DNSMASQ_CONF" --pid-file=/run/dnsmasq.pid

# ── start squid ──────────────────────────────────────────────────────────────
# Clean up stale PID file from a previous crash.
rm -f /run/squid.pid
log "Starting squid (conf: $SQUID_CONF)"
squid -f "$SQUID_CONF" -N &
SQUID_PID=$!

# Wait until squid is ready (port 3128 open).
for i in $(seq 1 20); do
    if ss -tlnp 2>/dev/null | grep -q ':3128 '; then
        log "Squid is ready."
        break
    fi
    sleep 0.5
done

# ── pi-web: session daemon ───────────────────────────────────────────────────
# The data dir may be a bind mount (host-created root-owned); fix permissions
# and remove any stale socket from a previous crash before starting.
# Note: on bind mounts (e.g. macOS Docker Desktop), rm may fail if the socket
# is owned by root — ignore the error since the daemon handles stale sockets.
log "Preparing pi-web data directory"
mkdir -p "$AGENT_HOME/.pi/web"
chown agent:agent "$AGENT_HOME/.pi/web"
rm -f "$AGENT_HOME/.pi/web/sessiond.sock" 2>/dev/null || true

# Run as agent directly (not inside sh -c) so SESSIOND_PID is the daemon PID.
log "Starting pi-web session daemon"
gosu agent env PI_WEB_DATA_DIR="$AGENT_HOME/.pi/web" pi-web-sessiond &
SESSIOND_PID=$!

# Wait until the session daemon socket is ready.
for i in $(seq 1 20); do
    if [ -S "$AGENT_HOME/.pi/web/sessiond.sock" ]; then
        log "Pi-web session daemon is ready."
        break
    fi
    sleep 0.5
done

# ── start supercronic (scheduler) ────────────────────────────────────────────
# Supercronic monitors the scheduler crontab and executes tasks as the agent user.
log "Starting supercronic (crontab: $SCHEDULER_CRONTAB)"
gosu agent supercronic -inotify "$SCHEDULER_CRONTAB" &
SUPERCRONIC_PID=$!

# ── exec the pi server as agent ──────────────────────────────────────────────
log "Handing off to pi server as user 'agent'"
exec gosu agent "$@"
