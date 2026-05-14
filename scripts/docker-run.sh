#!/usr/bin/env bash
# docker-run.sh — convenience launcher for the work sandbox.
#
# Usage:
#   ./scripts/docker-run.sh [OPTIONS]
#
# Environment variables (all optional):
#   WORKSPACE_DIR     — host path to mount as /workspace  (default: ./workspace)
#   CONFIG_DIR        — host path to mount as /config     (default: ./config)
#   PI_PORT           — host port for the pi web UI       (default: 4000)
#   NETWORK_MODE      — "allowlist" | "open-get"          (default: allowlist)
#   ANTHROPIC_API_KEY — passed to the container
#   OPENAI_API_KEY    — passed to the container
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WORKSPACE_DIR="${WORKSPACE_DIR:-$REPO_ROOT/workspace}"
CONFIG_DIR="${CONFIG_DIR:-$REPO_ROOT/config}"
PI_PORT="${PI_PORT:-4000}"
NETWORK_MODE="${NETWORK_MODE:-allowlist}"

mkdir -p "$WORKSPACE_DIR" "$CONFIG_DIR"

echo "Starting work sandbox…"
echo "  Workspace : $WORKSPACE_DIR"
echo "  Config    : $CONFIG_DIR"
echo "  UI port   : http://localhost:${PI_PORT}"
echo "  Network   : $NETWORK_MODE"
echo ""

docker run --rm -it \
    --name work-sandbox \
    --cap-drop NET_RAW \
    --cap-drop NET_ADMIN \
    --cap-drop SYS_PTRACE \
    -v "$WORKSPACE_DIR:/workspace" \
    -v "$CONFIG_DIR:/config" \
    -p "${PI_PORT}:4000" \
    -e "NETWORK_MODE=${NETWORK_MODE}" \
    -e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}" \
    -e "OPENAI_API_KEY=${OPENAI_API_KEY:-}" \
    work-sandbox:latest
