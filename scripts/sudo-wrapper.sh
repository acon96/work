#!/usr/bin/env bash
# sudo-wrapper — allowlist-checked sudo for the agent user.
#
# Usage (via sudoers):  sudo /usr/local/bin/sudo-wrapper <command> [args...]
#
# Security model:
#   1. The allowlist at /config/sudo-allowlist.txt is re-read on every call.
#   2. The exact reconstructed command string must appear verbatim in the list.
#   3. If the allowlist is missing or the command is not present, execution is
#      refused and nothing is run as root.
set -euo pipefail

ALLOWLIST="/config/sudo-allowlist.txt"

# Reconstruct the command string from arguments.
COMMAND="sudo $*"

# Normalise: collapse runs of whitespace.
NORMALIZED=$(echo "$COMMAND" | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//')

# Check the allowlist.
if [[ ! -f "$ALLOWLIST" ]]; then
    echo "sudo-wrapper: allowlist not found at $ALLOWLIST — denying." >&2
    exit 1
fi

FOUND=0
while IFS= read -r line; do
    # Skip blank lines and comments.
    [[ -z "$line" || "$line" =~ ^# ]] && continue
    # Normalise the allowlist entry too.
    ENTRY=$(echo "$line" | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//')
    if [[ "$NORMALIZED" == "$ENTRY" ]]; then
        FOUND=1
        break
    fi
done < "$ALLOWLIST"

if [[ "$FOUND" -eq 0 ]]; then
    echo "sudo-wrapper: '$NORMALIZED' not in allowlist — denying." >&2
    exit 1
fi

# Execute the actual command (dropping "sudo" from the passed-in args since
# the sudoers rule already grants the privilege).
exec "$@"
