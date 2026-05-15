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

log() { echo "[entrypoint] $*"; }

# ── env-var allowlist overrides ──────────────────────────────────────────────
# PROXY_ALLOWLIST: comma-separated domains, appends to /config/proxy-allowlist.txt
if [[ -n "${PROXY_ALLOWLIST:-}" ]]; then
    log "Proxy allowlist provided via env var"
    IFS=',' read -ra DOMAINS <<< "$PROXY_ALLOWLIST"
    for domain in "${DOMAINS[@]}"; do
        echo "$domain" >> "$CONFIG_DIR/proxy-allowlist.txt"
    done
fi

# SUDO_ALLOWLIST: comma-separated sudo commands, appends to /config/sudo-allowlist.txt
if [[ -n "${SUDO_ALLOWLIST:-}" ]]; then
    log "Sudo allowlist provided via env var"
    IFS=',' read -ra COMMANDS <<< "$SUDO_ALLOWLIST"
    for cmd in "${COMMANDS[@]}"; do
        echo "$cmd" >> "$CONFIG_DIR/sudo-allowlist.txt"
    done
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

# ── exec the pi server as agent ──────────────────────────────────────────────
log "Handing off to pi server as user 'agent'"
exec gosu agent "$@"
