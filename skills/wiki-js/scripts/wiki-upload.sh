#!/usr/bin/env bash
# wiki-upload.sh — Upload a single file as a Wiki.js asset via the REST endpoint POST /u.
#
# Prerequisites: $WIKI_URL and $WIKI_TOKEN must be set in the environment.
#
# Usage:
#   ./wiki-upload.sh /path/to/image.png
#   ./wiki-upload.sh /path/to/doc.pdf --folder 5
#   ./wiki-upload.sh /path/to/image.png --folder 0 --print
#
# Options:
#   --folder, -f ID   Destination folder ID (default: 0 = root).
#   --print, -p       Pretty-print the JSON response body.
#   --raw             Output raw response body without jq processing.
set -euo pipefail

WIKI_URL="${WIKI_URL:-}"
WIKI_TOKEN="${WIKI_TOKEN:-}"

if [[ -z "$WIKI_URL" ]]; then
  echo "Error: WIKI_URL is not set." >&2
  exit 1
fi
if [[ -z "$WIKI_TOKEN" ]]; then
  echo "Error: WIKI_TOKEN is not set." >&2
  exit 1
fi

FILE=""
FOLDER_ID=0
PRINT=false
RAW=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --folder|-f)
      FOLDER_ID="$2"
      shift 2
      ;;
    --print|-p)
      PRINT=true
      shift
      ;;
    --raw)
      RAW=true
      shift
      ;;
    *)
      if [[ -z "$FILE" ]]; then
        FILE="$1"
      else
        echo "Warning: ignoring extra argument: $1" >&2
      fi
      shift
      ;;
  esac
done

if [[ -z "$FILE" ]]; then
  echo "Error: no file specified." >&2
  echo "Usage: $0 <file-path> [--folder N] [--print]" >&2
  exit 1
fi

if [[ ! -f "$FILE" ]]; then
  echo "Error: file not found: $FILE" >&2
  exit 1
fi

ENDPOINT="${WIKI_URL%/}/u"
METADATA="{\"folderId\":${FOLDER_ID}}"

# The upload endpoint accepts:
#   -F "mediaUpload=<metadata-json>"  (folder selection)
#   -F "mediaUpload=@<file>"          (the actual file)
if [[ "$RAW" == "true" ]]; then
  curl -fsSL \
    -H "Authorization: Bearer ${WIKI_TOKEN}" \
    -F "mediaUpload=${METADATA}" \
    -F "mediaUpload=@${FILE}" \
    "$ENDPOINT"
elif [[ "$PRINT" == "true" ]]; then
  curl -fsSL \
    -H "Authorization: Bearer ${WIKI_TOKEN}" \
    -F "mediaUpload=${METADATA}" \
    -F "mediaUpload=@${FILE}" \
    "$ENDPOINT" | jq .
else
  curl -fsSL \
    -H "Authorization: Bearer ${WIKI_TOKEN}" \
    -F "mediaUpload=${METADATA}" \
    -F "mediaUpload=@${FILE}" \
    "$ENDPOINT" | jq -c .
fi
