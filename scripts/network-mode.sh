#!/usr/bin/env bash
# network-mode.sh — runtime network mode switching for squid + dnsmasq
set -euo pipefail

CONFIG_DIR="${CONFIG_DIR:-/config}"
WORK_CONFIG="${WORK_CONFIG:-/etc/work}"
STATE_DIR="/run/work"
MODE_FILE="$STATE_DIR/network-mode"
STATE_JSON="$STATE_DIR/network-state.json"
DNSMASQ_PID_FILE="/run/dnsmasq.pid"
SQUID_PID_FILE="/run/squid.pid"
RUNTIME_DNSMASQ_ALLOWLIST="/run/dnsmasq-allowlist.conf"
RUNTIME_SQUID_OPEN_GET="/run/squid-open-get.runtime.conf"

log() { echo "[network-mode] $*"; }

usage() {
    cat <<'EOF'
Usage:
  network-mode status [--json]
  network-mode current
  network-mode set <allowlist|open-get>

Commands:
  status    Print current runtime network mode and active config paths.
  current   Print only the current runtime mode.
  set       Switch runtime mode and reload dnsmasq + squid.
EOF
}

normalize_mode() {
    local mode="$1"
    case "$mode" in
        allowlist|open-get)
            printf '%s\n' "$mode"
            ;;
        *)
            return 1
            ;;
    esac
}

read_mode() {
    if [[ -f "$MODE_FILE" ]]; then
        local mode
        mode="$(tr -d '[:space:]' < "$MODE_FILE")"
        if normalize_mode "$mode" >/dev/null 2>&1; then
            printf '%s\n' "$mode"
            return 0
        fi
    fi

    local fallback="${NETWORK_MODE:-allowlist}"
    if normalize_mode "$fallback" >/dev/null 2>&1; then
        printf '%s\n' "$fallback"
        return 0
    fi

    printf 'allowlist\n'
}

render_allowlist_dnsmasq_conf() {
    local upstream_dns
    upstream_dns="$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf.upstream 2>/dev/null || true)"

    cp "$WORK_CONFIG/dnsmasq-allowlist.conf" "$RUNTIME_DNSMASQ_ALLOWLIST"

    if [[ -z "$upstream_dns" ]]; then
        log "Warning: no upstream resolver found in /etc/resolv.conf.upstream"
        return 0
    fi

    if [[ -f "$CONFIG_DIR/proxy-allowlist.txt" ]]; then
        while IFS= read -r domain; do
            [[ -z "$domain" || "$domain" =~ ^[[:space:]]*# ]] && continue
            echo "server=/${domain}/${upstream_dns}" >> "$RUNTIME_DNSMASQ_ALLOWLIST"
        done < "$CONFIG_DIR/proxy-allowlist.txt"
    fi
}

render_open_get_squid_conf() {
    cp "$WORK_CONFIG/squid-open-get.conf" "$RUNTIME_SQUID_OPEN_GET"

    # URL rewrite is optional; strip directives when disabled.
    if [[ "${URL_REWRITE_ENABLED:-false}" != "true" ]]; then
        awk '
            $1 == "url_rewrite_program" { next }
            $1 == "url_rewrite_children" { next }
            $1 == "url_rewrite_concurrency" { next }
            { print }
        ' "$RUNTIME_SQUID_OPEN_GET" > "$RUNTIME_SQUID_OPEN_GET.tmp"
        mv "$RUNTIME_SQUID_OPEN_GET.tmp" "$RUNTIME_SQUID_OPEN_GET"
    fi
}

apply_mode() {
    local mode="$1"
    local dnsmasq_conf=""
    local squid_conf=""

    case "$mode" in
        allowlist)
            render_allowlist_dnsmasq_conf
            dnsmasq_conf="$RUNTIME_DNSMASQ_ALLOWLIST"
            squid_conf="$WORK_CONFIG/squid-allowlist.conf"
            ;;
        open-get)
            dnsmasq_conf="$WORK_CONFIG/dnsmasq-open.conf"
            render_open_get_squid_conf
            squid_conf="$RUNTIME_SQUID_OPEN_GET"
            ;;
        *)
            log "Unsupported mode: $mode"
            return 1
            ;;
    esac

    dnsmasq --test --conf-file="$dnsmasq_conf" >/dev/null
    squid -k parse -f "$squid_conf" >/dev/null

    if [[ -f "$DNSMASQ_PID_FILE" ]] && kill -0 "$(cat "$DNSMASQ_PID_FILE")" 2>/dev/null; then
        kill "$(cat "$DNSMASQ_PID_FILE")"
        for _ in $(seq 1 20); do
            if [[ ! -f "$DNSMASQ_PID_FILE" ]] || ! kill -0 "$(cat "$DNSMASQ_PID_FILE" 2>/dev/null || true)" 2>/dev/null; then
                break
            fi
            sleep 0.2
        done
    fi

    dnsmasq --conf-file="$dnsmasq_conf" --pid-file="$DNSMASQ_PID_FILE"

    if [[ -f "$SQUID_PID_FILE" ]] && kill -0 "$(cat "$SQUID_PID_FILE")" 2>/dev/null; then
        squid -k reconfigure -f "$squid_conf"
    else
        rm -f "$SQUID_PID_FILE"
        squid -f "$squid_conf" -N &

        for _ in $(seq 1 20); do
            if ss -tlnp 2>/dev/null | grep -q ':3128 '; then
                break
            fi
            sleep 0.5
        done
    fi

    mkdir -p "$STATE_DIR"
    printf '%s\n' "$mode" > "$MODE_FILE"

    jq -n \
        --arg mode "$mode" \
        --arg dnsmasqConf "$dnsmasq_conf" \
        --arg squidConf "$squid_conf" \
        --arg urlRewriteEnabled "${URL_REWRITE_ENABLED:-false}" \
        --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
            mode: $mode,
            dnsmasqConf: $dnsmasqConf,
            squidConf: $squidConf,
            urlRewriteEnabled: ($urlRewriteEnabled == "true"),
            updatedAt: $updatedAt
        }' > "$STATE_JSON"
}

print_status_json() {
    if [[ -f "$STATE_JSON" ]]; then
        cat "$STATE_JSON"
        return 0
    fi

    local mode
    mode="$(read_mode)"
    jq -n --arg mode "$mode" '{ mode: $mode }'
}

print_status_text() {
    local mode
    mode="$(read_mode)"

    if [[ -f "$STATE_JSON" ]]; then
        jq -r '"mode=\(.mode)\ndnsmasq_conf=\(.dnsmasqConf // "")\nsquid_conf=\(.squidConf // "")\nurl_rewrite_enabled=\(.urlRewriteEnabled // false)\nupdated_at=\(.updatedAt // "")"' "$STATE_JSON"
        return 0
    fi

    printf 'mode=%s\n' "$mode"
}

main() {
    local command="${1:-status}"

    case "$command" in
        status)
            if [[ "${2:-}" == "--json" ]]; then
                print_status_json
            else
                print_status_text
            fi
            ;;
        current)
            read_mode
            ;;
        set)
            if [[ $# -lt 2 ]]; then
                log "Missing mode for set command"
                usage
                exit 2
            fi
            local mode
            if ! mode="$(normalize_mode "$2")"; then
                log "Invalid mode: $2"
                usage
                exit 2
            fi

            apply_mode "$mode"
            log "Runtime network mode set to: $mode"
            print_status_text
            ;;
        -h|--help|help)
            usage
            ;;
        *)
            log "Unknown command: $command"
            usage
            exit 2
            ;;
    esac
}

main "$@"
