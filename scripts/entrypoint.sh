#!/usr/bin/env bash
# entrypoint.sh — container start-up:
#   1. Bootstrap /config files (allowlists, with env-var overrides)
#   2. Configure dnsmasq for the selected NETWORK_MODE
#   3. Configure squid for the selected NETWORK_MODE (with optional URL rewrite)
#   4. Bootstrap .pi/settings.json (SearXNG, sessionDir)
#   5. Copy local extensions to agent's .pi/extensions
#   6. Start dnsmasq and squid
#   7. Exec the pi server as the "work" user
set -euo pipefail

NETWORK_MODE="${NETWORK_MODE:-allowlist}"
CONFIG_DIR="/config"
WORK_CONFIG="/etc/work"
AGENT_HOME="/home/agent"

log() { echo "[entrypoint] $*"; }

# ── env-var allowlist overrides ──────────────────────────────────────────────
# PROXY_ALLOWLIST: newline-separated domains, overrides /config/proxy-allowlist.txt
if [[ -n "${PROXY_ALLOWLIST:-}" ]]; then
    log "Proxy allowlist provided via env var"
    echo "$PROXY_ALLOWLIST" > "$CONFIG_DIR/proxy-allowlist.txt"
fi

# SUDO_ALLOWLIST: newline-separated sudo commands, overrides /config/sudo-allowlist.txt
if [[ -n "${SUDO_ALLOWLIST:-}" ]]; then
    log "Sudo allowlist provided via env var"
    echo "$SUDO_ALLOWLIST" > "$CONFIG_DIR/sudo-allowlist.txt"
fi

# ── bootstrap /config if volume was mounted empty ───────────────────────────
[[ -f "$CONFIG_DIR/proxy-allowlist.txt" ]] \
    || cp "$WORK_CONFIG/proxy-allowlist.txt.default" "$CONFIG_DIR/proxy-allowlist.txt"
[[ -f "$CONFIG_DIR/sudo-allowlist.txt" ]] \
    || cp "$WORK_CONFIG/sudo-allowlist.txt.default"  "$CONFIG_DIR/sudo-allowlist.txt"

# ── resolv.conf ──────────────────────────────────────────────────────────────
# Save original upstream resolvers before we replace resolv.conf with
# 127.0.0.1 (needed by dnsmasq open mode).
cp /etc/resolv.conf /etc/resolv.conf.upstream 2>/dev/null || true
echo "nameserver 127.0.0.1" > /etc/resolv.conf

# ── dnsmasq config ───────────────────────────────────────────────────────────
if [[ "$NETWORK_MODE" == "allowlist" ]]; then
    log "Network mode: allowlist"
    DNSMASQ_CONF="$WORK_CONFIG/dnsmasq-allowlist.conf"

    # Append per-domain server= directives from the allowlist.
    RUNTIME_DNSMASQ="/run/dnsmasq-allowlist.conf"
    cp "$DNSMASQ_CONF" "$RUNTIME_DNSMASQ"
    while IFS= read -r domain; do
        [[ -z "$domain" || "$domain" =~ ^# ]] && continue
        echo "server=/${domain}/8.8.8.8" >> "$RUNTIME_DNSMASQ"
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

# ── bootstrap .pi/settings.json for the agent user ───────────────────────────
# Merge env-var SearXNG URL into settings if provided.
SETTINGS_DIR="$AGENT_HOME/.pi"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"
mkdir -p "$SETTINGS_DIR"

if [[ -f "$SETTINGS_FILE" ]]; then
    # Settings already exist (from volume mount) — skip.
    log ".pi/settings.json already exists, skipping bootstrap"
else
    log "Bootstrapping .pi/settings.json"
    # Start from the template
    cp /home/work/.pi/settings.json "$SETTINGS_FILE" 2>/dev/null || true

    # Inject SearXNG URL if provided.
    if [[ -n "${SEARXNG_URL:-}" ]]; then
        log "Configuring SearXNG endpoint: $SEARXNG_URL"
        # Create a project-level settings override that sets the SearXNG API key
        # (pi-searxng reads SearXNG_URL from the environment at runtime)
        export SearXNG_URL="$SEARXNG_URL"
    fi

    chown -R agent:agent "$SETTINGS_DIR"
fi

# ── copy local extensions to agent's .pi/extensions ──────────────────────────
AGENT_EXT_DIR="$AGENT_HOME/.pi/extensions"
mkdir -p "$AGENT_EXT_DIR"
for ext in /home/work/.pi/extensions/*.ts; do
    [[ -f "$ext" ]] || continue
    cp "$ext" "$AGENT_EXT_DIR/"
done
chown -R agent:agent "$AGENT_HOME/.pi"

# ── exec the pi server as work ───────────────────────────────────────────────
log "Handing off to pi server as user 'work'"
exec gosu work "$@"
