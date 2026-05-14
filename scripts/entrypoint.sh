#!/usr/bin/env bash
# entrypoint.sh — container start-up:
#   1. Validate / bootstrap /config files
#   2. Configure dnsmasq for the selected NETWORK_MODE
#   3. Configure squid for the selected NETWORK_MODE
#   4. Start dnsmasq and squid
#   5. Exec the pi server as the "work" user
set -euo pipefail

NETWORK_MODE="${NETWORK_MODE:-allowlist}"
CONFIG_DIR="/config"
WORK_CONFIG="/etc/work"

log() { echo "[entrypoint] $*"; }

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

# ── exec the pi server as work ───────────────────────────────────────────────
log "Handing off to pi server as user 'work'"
exec gosu work "$@"
