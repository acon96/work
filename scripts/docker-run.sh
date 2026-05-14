#!/usr/bin/env bash
# docker-run.sh — convenience launcher for the work sandbox.
#
# Usage:
#   ./scripts/docker-run.sh [OPTIONS]
#
# Environment variables (all optional):
#   WORKSPACE_DIR       — host path to mount as /workspace  (default: ./workspace)
#   CONFIG_DIR          — host path to mount as /config     (default: ./config)
#   PI_PORT             — host port for the pi web UI       (default: 4000)
#   SEARXNG_PORT        — host port for SearXNG             (default: 8080)
#   NETWORK_MODE        — "allowlist" | "open-get"          (default: allowlist)
#   SEARXNG_URL         — SearXNG endpoint URL              (default: http://searxng:8080)
#   URL_REWRITE_ENABLED — enable URL query-string stripping  (default: false)
#   PROXY_ALLOWLIST     — newline-separated domains (inline)
#   SUDO_ALLOWLIST      — newline-separated sudo cmds (inline)
#   ANTHROPIC_API_KEY   — passed to the container
#   OPENAI_API_KEY      — passed to the container
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WORKSPACE_DIR="${WORKSPACE_DIR:-$REPO_ROOT/workspace}"
CONFIG_DIR="${CONFIG_DIR:-$REPO_ROOT/config}"
PI_PORT="${PI_PORT:-4000}"
SEARXNG_PORT="${SEARXNG_PORT:-8080}"
NETWORK_MODE="${NETWORK_MODE:-allowlist}"

mkdir -p "$WORKSPACE_DIR" "$CONFIG_DIR"

echo "Starting work sandbox…"
echo "  Workspace : $WORKSPACE_DIR"
echo "  Config    : $CONFIG_DIR"
echo "  UI port   : http://localhost:${PI_PORT}"
echo "  SearXNG   : http://localhost:${SEARXNG_PORT}"
echo "  Network   : $NETWORK_MODE"
echo ""

# ── build the docker run command ─────────────────────────────────────────────
# Start with base flags.
DRUN=(
    docker run --rm -it
    --name work-sandbox
    --cap-drop NET_RAW
    --cap-drop NET_ADMIN
    --cap-drop SYS_PTRACE
    -v "$WORKSPACE_DIR:/workspace"
    -v "$CONFIG_DIR:/config"
    -p "${PI_PORT}:4000"
    -p "${SEARXNG_PORT}:8080"
    -e "NETWORK_MODE=${NETWORK_MODE}"
    -e "SEARXNG_URL=${SEARXNG_URL:-http://searxng:8080}"
    -e "URL_REWRITE_ENABLED=${URL_REWRITE_ENABLED:-false}"
    -e "PROXY_ALLOWLIST=${PROXY_ALLOWLIST:-}"
    -e "SUDO_ALLOWLIST=${SUDO_ALLOWLIST:-}"
    -e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}"
    -e "OPENAI_API_KEY=${OPENAI_API_KEY:-}"
    work-sandbox:latest
)

"${DRUN[@]}"
