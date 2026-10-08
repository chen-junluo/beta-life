#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCT_NAME="Beta Life"
VERSION="$(node --input-type=module -e "import fs from 'node:fs'; console.log(JSON.parse(fs.readFileSync('package.json', 'utf8')).version)")"
ARCH="$(uname -m)"

case "$ARCH" in
  arm64)
    DMG_ARCH="aarch64"
    ;;
  x86_64)
    DMG_ARCH="x64"
    ;;
  *)
    echo "Unsupported macOS architecture: $ARCH" >&2
    exit 1
    ;;
esac

DMG_PATH="$ROOT_DIR/src-tauri/target/release/bundle/dmg/${PRODUCT_NAME}_${VERSION}_${DMG_ARCH}.dmg"
APP_PATH="$ROOT_DIR/src-tauri/target/release/bundle/macos/${PRODUCT_NAME}.app"

echo "==> Cleaning generated caches and build output"
rm -rf "$ROOT_DIR/dist" "$ROOT_DIR/node_modules/.vite"
cargo clean --manifest-path "$ROOT_DIR/src-tauri/Cargo.toml"
rm -f "$DMG_PATH"

echo "==> Building the macOS application and DMG"
BUILD_EXIT=0
if LC_ALL=C LANG=C npm run build:mac; then
  :
else
  BUILD_EXIT=$?
  echo "Tauri's DMG bundler did not finish; continuing with the direct DMG fallback."
fi

create_fallback_dmg() {
  if [[ ! -d "$APP_PATH" ]]; then
    echo "The release app was not produced: $APP_PATH" >&2
    exit "${BUILD_EXIT:-1}"
  fi

  local stage_dir
  stage_dir="$(mktemp -d /private/tmp/beta-life-dmg-stage.XXXXXX)"
  trap 'rm -rf "$stage_dir"' EXIT

  cp -R "$APP_PATH" "$stage_dir/$PRODUCT_NAME.app"
  ln -s /Applications "$stage_dir/Applications"

  echo "==> Creating the drag-to-Applications DMG"
  hdiutil create \
    -volname "$PRODUCT_NAME" \
    -srcfolder "$stage_dir" \
    -ov \
    -format UDZO \
    "$DMG_PATH"
}

if [[ ! -f "$DMG_PATH" ]]; then
  create_fallback_dmg
fi

echo "==> Verifying the DMG"
hdiutil verify "$DMG_PATH"

echo "==> Opening the installer window"
open "$DMG_PATH"

echo ""
echo "DMG ready: $DMG_PATH"
echo "Finder should now show Beta Life.app and the Applications shortcut."
