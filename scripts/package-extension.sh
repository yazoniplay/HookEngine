#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
ZIP_PATH="$DIST_DIR/hookengine-chrome-web-store.zip"

cd "$ROOT_DIR"
rm -f "$ZIP_PATH"
mkdir -p "$DIST_DIR"

zip -r -X "$ZIP_PATH" \
  manifest.json \
  background.js \
  content.js \
  popup.html \
  sidepanel.js \
  styles.css \
  settings.html \
  settings.js \
  icons \
  vendor \
  extension/auth.js \
  extension/config.js

echo "Created $ZIP_PATH"
