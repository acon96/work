#!/usr/bin/env bash
# wiki-gql.sh — Send a GraphQL query or mutation to the Wiki.js API.
#
# Prerequisites: $WIKI_URL and $WIKI_TOKEN must be set in the environment.
#
# Usage:
#   ./wiki-gql.sh '{ pages { list { id path title } } }'
#   ./wiki-gql.sh --file path/to/query.gql
#   ./wiki-gql.sh 'mutation($p:String!){ pages { singleByPath(path:$p) { id } } }' --var 'path:guide/intro' --print
#
# Options:
#   --file, -f PATH   Read the query from a file instead of the first argument.
#   --var,  -v KEY:VALUE   Bind a GraphQL variable (can be repeated).
#   --print, -p     Pass -p to jq for pretty-printed output (default: raw).
#   --raw           Output the raw response body (no jq processing).
#   --header, -H    Extra curl header in "Key: Value" format (repeatable).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WIKI_URL="${WIKI_URL:-}"
WIKI_TOKEN="${WIKI_TOKEN:-}"

if [[ -z "$WIKI_URL" ]]; then
  echo "Error: WIKI_URL is not set. Export it, e.g.:" >&2
  echo '  export WIKI_URL="https://your-wiki.example.com"' >&2
  exit 1
fi
if [[ -z "$WIKI_TOKEN" ]]; then
  echo "Error: WIKI_TOKEN is not set. Export it, e.g.:" >&2
  echo '  export WIKI_TOKEN="<your-jwt-api-key>"' >&2
  exit 1
fi

QUERY=""
PRINT=false
RAW=false
EXTRA_HEADERS=()
VARS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file|-f)
      QUERY=$(cat "$2")
      shift 2
      ;;
    --var|-v)
      # Store variable for later binding
      VARS+=("$2")
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
    --header|-H)
      EXTRA_HEADERS+=("$2")
      shift 2
      ;;
    *)
      if [[ -z "$QUERY" ]]; then
        QUERY="$1"
      else
        echo "Warning: ignoring extra argument: $1" >&2
      fi
      shift
      ;;
  esac
done

if [[ -z "$QUERY" ]]; then
  echo "Error: no query provided." >&2
  echo "Usage: $0 '<graphql-query>' [--file file.gql] [--var key:value] [--print]" >&2
  exit 1
fi

# Build the JSON payload with optional variables
PAYLOAD=$(jq -n --arg query "$QUERY" '{query: $query}')

if [[ ${#VARS[@]} -gt 0 ]]; then
  PAYLOAD=$(echo "$PAYLOAD" | jq '. + {variables: {}}')
  for v in "${VARS[@]}"; do
    KEY="${v%%:*}"
    VAL="${v#*:}"
    PAYLOAD=$(echo "$PAYLOAD" | jq --arg k "$KEY" --arg v "$VAL" '.variables[$k] = $v')
  done
fi

# Make the request
HEADERS=(-H "Content-Type: application/json" -H "Authorization: Bearer ${WIKI_TOKEN}")
for h in "${EXTRA_HEADERS[@]}"; do
  HEADERS+=(-H "$h")
done

ENDPOINT="${WIKI_URL%/}/graphql"

if [[ "$RAW" == "true" ]]; then
  curl -fsSL "${HEADERS[@]}" -X POST "$ENDPOINT" -d "$PAYLOAD"
elif [[ "$PRINT" == "true" ]]; then
  curl -fsSL "${HEADERS[@]}" -X POST "$ENDPOINT" -d "$PAYLOAD" | jq .
else
  curl -fsSL "${HEADERS[@]}" -X POST "$ENDPOINT" -d "$PAYLOAD" | jq -c .
fi
