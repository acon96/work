#!/usr/bin/env bash
# healthcheck.sh — verify all critical sandbox services are running
set -euo pipefail

EXIT_CODE=0
PI_WEB_DATA_DIR="${PI_WEB_DATA_DIR:-/home/agent/.pi/web}"
PI_WEB_SESSIOND_SOCKET="${PI_WEB_SESSIOND_SOCKET:-/tmp/pi-web/sessiond.sock}"

# Check squid (proxy) - port 3128 should be listening
if ! ss -tlnp 2>/dev/null | grep -q ':3128 '; then
    echo "UNHEALTHY: squid not listening on port 3128"
    EXIT_CODE=1
fi

# Check dnsmasq - port 53 should be listening
if ! ss -ulnp 2>/dev/null | grep -q ':53 '; then
    echo "UNHEALTHY: dnsmasq not listening on port 53 (UDP)"
    EXIT_CODE=1
fi

# Check pi-web session daemon - socket should exist
if [ ! -S "$PI_WEB_SESSIOND_SOCKET" ]; then
    echo "UNHEALTHY: pi-web session daemon socket not found at $PI_WEB_SESSIOND_SOCKET"
    EXIT_CODE=1
fi

# Check pi-web server - port 8504 should be listening
if ! ss -tlnp 2>/dev/null | grep -q ':8504 '; then
    echo "UNHEALTHY: pi-web server not listening on port 8504"
    EXIT_CODE=1
fi

# Check supercronic - process should be running
if ! pgrep -f "supercronic.*scheduler.crontab" > /dev/null 2>&1; then
    echo "UNHEALTHY: supercronic not running"
    EXIT_CODE=1
fi

if [ $EXIT_CODE -eq 0 ]; then
    echo "HEALTHY: All critical services running (squid, dnsmasq, pi-web, supercronic)"
fi

exit $EXIT_CODE
