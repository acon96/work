#!/usr/bin/env bash
# build-plugins.sh — compile TypeScript pi-web plugins to JavaScript during Docker build.
#
# Each plugin directory under pi-web-plugins/ may contain a tsconfig.json.
# Plugins with a tsconfig.json are compiled with tsc; those without are copied as-is.
# The compiled output is placed in the pi-web plugins directory inside node_modules.
set -euo pipefail

SRC_DIR="${1:-/app/.pi-web-plugins-src}"
DEST_DIR="${2:-/app/node_modules/@jmfederico/pi-web/dist/pi-web-plugins}"

log() { echo "[build-plugins] $*"; }

# Remove bundled plugins we replace (space-separated in PI_WEB_REPLACE_PLUGINS env var).
if [ -n "${PI_WEB_REPLACE_PLUGINS:-}" ]; then
  for plugin_id in $PI_WEB_REPLACE_PLUGINS; do
    rm -rf "$DEST_DIR/$plugin_id"
    log "Removed bundled plugin: $plugin_id"
  done
fi

# Ensure the destination directory exists.
mkdir -p "$DEST_DIR"

# Compile each plugin that has a tsconfig.json, then strip source artifacts.
for plugin_dir in "$SRC_DIR"/*/; do
  [ -d "$plugin_dir" ] || continue
  plugin_name="$(basename "$plugin_dir")"

  if [ -f "$plugin_dir/tsconfig.json" ]; then
    log "Compiling TypeScript plugin: $plugin_name"
    (cd "$plugin_dir" && npx tsc --project tsconfig.json)

    # Remove build-only files so only compiled output remains.
    rm -f "$plugin_dir/tsconfig.json"
    # Remove .ts source files (keep .js output).
    for ts_file in "$plugin_dir"/*.ts "$plugin_dir"/**/*.ts; do
      [ -f "$ts_file" ] && rm -f "$ts_file"
    done
  else
    log "Copying (no TypeScript) plugin: $plugin_name"
  fi
done

# Copy all compiled plugins into the pi-web plugins directory.
cp -r "$SRC_DIR"/* "$DEST_DIR/"

# Clean up build artifacts.
rm -rf "$SRC_DIR"
rm -f /app/*.tsbuildinfo 2>/dev/null || true

log "Plugin build complete. Installed plugins: $(ls "$DEST_DIR")"
