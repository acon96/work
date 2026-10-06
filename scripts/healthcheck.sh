#!/usr/bin/env bash
# healthcheck.sh - verify all critical sandbox services are running
set -euo pipefail

EXIT_CODE=0
PI_WEB_DATA_DIR="${PI_WEB_DATA_DIR:-/home/agent/.pi/web}"
PI_WEB_SESSIOND_SOCKET="${PI_WEB_SESSIOND_SOCKET:-/tmp/pi-web/sessiond.sock}"

# Check the pi-sandbox execution substrate. pi-sandbox wraps every Bash tool
# invocation in bubblewrap; if unprivileged user namespaces or bwrap itself are
# unavailable the security model is silently degraded, so treat that as
# unhealthy. The probe mirrors the flag set the wrapper will actually request:
# inside a container (the default) it binds the container's /proc, because an
# unprivileged bwrap cannot remount a fresh procfs; with
# PI_SANDBOX_WEAKER_NESTED=off the wrapper asks for --proc instead, which only
# works when the sandbox is not nested.
if ! command -v bwrap > /dev/null 2>&1; then
    echo "UNHEALTHY: bwrap not installed (pi-sandbox cannot enforce Bash policy)"
    EXIT_CODE=1
else
    if [ "${PI_SANDBOX_WEAKER_NESTED:-on}" = "off" ]; then
        PROC_ARGS=(--proc /proc)
    else
        PROC_ARGS=(--bind /proc /proc)
    fi
    if ! bwrap --ro-bind / / --dev /dev --unshare-all --share-net \
            --unshare-pid --unshare-user "${PROC_ARGS[@]}" /bin/true > /dev/null 2>&1; then
        echo "UNHEALTHY: bwrap cannot create sandboxes (check user namespaces / seccomp / AppArmor; PI_SANDBOX_WEAKER_NESTED=${PI_SANDBOX_WEAKER_NESTED:-on})"
        EXIT_CODE=1
    fi
fi

# Check pi-web session daemon - the socket must exist and answer HTTP requests.
# A Unix socket file can remain after its listener exits, so -S alone is not a
# liveness check. The daemon's /health endpoint is intentionally independent of
# any individual session or model-provider state.
if [ ! -S "$PI_WEB_SESSIOND_SOCKET" ]; then
    echo "UNHEALTHY: pi-web session daemon socket not found at $PI_WEB_SESSIOND_SOCKET"
    EXIT_CODE=1
elif ! curl --fail --silent --max-time 3 \
    --unix-socket "$PI_WEB_SESSIOND_SOCKET" \
    http://localhost/health > /dev/null 2>&1; then
    echo "UNHEALTHY: pi-web session daemon is not responding at $PI_WEB_SESSIOND_SOCKET"
    EXIT_CODE=1
fi

# Check pi-web server - port 8504 should be listening
if ! curl --fail --silent --max-time 3 http://localhost:8504/ > /dev/null 2>&1; then
    echo "UNHEALTHY: pi-web server not listening on port 8504"
    EXIT_CODE=1
fi

# Check supercronic - process should be running
if ! pgrep -f "supercronic.*scheduler.crontab" > /dev/null 2>&1; then
    echo "UNHEALTHY: supercronic not running"
    EXIT_CODE=1
fi

if [ $EXIT_CODE -eq 0 ]; then
    echo "HEALTHY: All critical services running (sandbox substrate, pi-web, supercronic)"
fi

exit $EXIT_CODE
