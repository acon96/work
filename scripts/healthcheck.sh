#!/usr/bin/env bash
# healthcheck.sh - verify all critical sandbox services are running
set -euo pipefail

EXIT_CODE=0
PI_WEB_DATA_DIR="${PI_WEB_DATA_DIR:-/home/agent/.pi/web}"
PI_WEB_SESSIOND_SOCKET="${PI_WEB_SESSIOND_SOCKET:-/tmp/pi-web/sessiond.sock}"

# Check the pi-sandbox execution substrate. pi-sandbox wraps every Bash tool
# invocation in bubblewrap; if unprivileged user namespaces or bwrap itself are
# unavailable the security model is silently degraded, so treat that as
# unhealthy. This mirrors pi-sandbox's own preflight (a minimal bind-mounted
# sandbox with a procfs remount and network isolation).  The --proc mount is
# the part an unprivileged container refuses without CAP_SYS_ADMIN, so it
# must be in the probe.
if ! command -v bwrap > /dev/null 2>&1; then
    echo "UNHEALTHY: bwrap not installed (pi-sandbox cannot enforce Bash policy)"
    EXIT_CODE=1
elif ! bwrap --ro-bind / / --unshare-all --share-net --proc /proc /bin/true > /dev/null 2>&1; then
    echo "UNHEALTHY: bwrap cannot create sandboxes (check user namespaces / CAP_SYS_ADMIN on bwrap / seccomp / AppArmor)"
    EXIT_CODE=1
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
