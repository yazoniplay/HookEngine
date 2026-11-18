#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
ZIP_PATH="$DIST_DIR/hookengine-chrome-web-store.zip"

cd "$ROOT_DIR"
rm -f "$ZIP_PATH"
mkdir -p "$DIST_DIR"

# Fail early if a manifest or imported runtime dependency is missing.
required_files=(
  manifest.json background.js content.js popup.html sidepanel.js styles.css
  settings.html settings.js settings.css
  extension/auth.js extension/config.js extension/usage-display.mjs
  vendor/readability.js
  icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png
)
for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing required extension file: $file" >&2
    exit 1
  fi
done

zip -r -X "$ZIP_PATH" \
  manifest.json \
  background.js \
  content.js \
  popup.html \
  sidepanel.js \
  styles.css \
  settings.html \
  settings.js \
  settings.css \
  icons \
  vendor \
  extension/auth.js \
  extension/config.js \
  extension/usage-display.mjs

# Verify the archive contains every required file.
for file in "${required_files[@]}"; do
  if ! unzip -Z1 "$ZIP_PATH" | grep -Fxq "$file"; then
    echo "Packaged ZIP is missing required file: $file" >&2
    exit 1
  fi
done

echo "Created and verified $ZIP_PATH"
