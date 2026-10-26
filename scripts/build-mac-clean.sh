#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCT_NAME="beta-life"
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
DMG_DIR="$(dirname "$DMG_PATH")"

# Two clean builds at once can race cargo clean, Tauri's temporary image, and
# hdiutil's device attachments. lockf is available on macOS and releases the
# lock automatically when this process exits.
LOCK_FILE="${TMPDIR:-/private/tmp}/beta-life-build-mac-clean-$(id -u).lock"
exec 9>"$LOCK_FILE"
if ! /usr/bin/lockf -s -t 0 9; then
  echo "Another beta-life macOS build is already running." >&2
  exit 1
fi

detach_previous_installer() {
  local device
  if ! device="$(hdiutil info | awk -v target="$DMG_PATH" '
    /^image-path[[:space:]]*:/ {
      path = $0
      sub(/^[^:]*:[[:space:]]*/, "", path)
      matches = (path == target)
      next
    }
    matches && $1 ~ /^\/dev\/disk[0-9]+$/ { print $1; exit }
  ')"; then
    echo "Could not inspect attached disk images; refusing to replace $DMG_PATH." >&2
    return 1
  fi

  [[ -n "$device" ]] || return 0

  echo "==> Ejecting the previously opened installer ($device)"
  local attempt
  for ((attempt = 1; attempt <= 3; attempt++)); do
    if hdiutil detach "$device"; then
      return 0
    fi
    if (( attempt < 3 )); then
      echo "The installer volume is busy; retrying in $((attempt * 2))s." >&2
      sleep "$((attempt * 2))"
    fi
  done

  echo "Could not eject $DMG_PATH. Close files or apps using its volume, then retry." >&2
  return 1
}

detach_previous_installer

FALLBACK_STAGE_DIR=""
FALLBACK_IMAGE_DIR=""
FALLBACK_LOG=""
cleanup_fallback_files() {
  [[ -z "$FALLBACK_STAGE_DIR" ]] || rm -rf "$FALLBACK_STAGE_DIR" || true
  [[ -z "$FALLBACK_IMAGE_DIR" ]] || rm -rf "$FALLBACK_IMAGE_DIR" || true
  [[ -z "$FALLBACK_LOG" ]] || rm -f "$FALLBACK_LOG" || true
}
trap cleanup_fallback_files EXIT

echo "==> Cleaning generated caches and build output"
rm -rf "$ROOT_DIR/dist" "$ROOT_DIR/node_modules/.vite"
cargo clean --manifest-path "$ROOT_DIR/src-tauri/Cargo.toml"
mkdir -p "$DMG_DIR"
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
    if (( BUILD_EXIT != 0 )); then
      exit "$BUILD_EXIT"
    fi
    exit 1
  fi

  FALLBACK_STAGE_DIR="$(mktemp -d /private/tmp/beta-life-dmg-stage.XXXXXX)"
  FALLBACK_IMAGE_DIR="$(mktemp -d /private/tmp/beta-life-dmg-image.XXXXXX)"
  local raw_dmg="$FALLBACK_IMAGE_DIR/$PRODUCT_NAME.raw.dmg"
  local temp_dmg="$FALLBACK_IMAGE_DIR/$(basename "$DMG_PATH")"
  FALLBACK_LOG="$(mktemp /private/tmp/beta-life-hdiutil.XXXXXX)"

  cp -R "$APP_PATH" "$FALLBACK_STAGE_DIR/$PRODUCT_NAME.app"
  ln -s /Applications "$FALLBACK_STAGE_DIR/Applications"

  # hdiutil create needs a virtual disk attachment here and can fail with
  # "Device not configured". makehybrid writes HFS+ directly; convert then
  # compresses that image without attaching it.
  local attempt max_attempts=4 retry_delay=3 status=1
  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    rm -f "$raw_dmg" "$temp_dmg"
    : > "$FALLBACK_LOG"
    echo "==> Creating the drag-to-Applications DMG without attaching an image (attempt $attempt/$max_attempts)"

    if hdiutil makehybrid \
      -default-volume-name "$PRODUCT_NAME" \
      -hfs \
      -o "$raw_dmg" \
      "$FALLBACK_STAGE_DIR" >"$FALLBACK_LOG" 2>&1 \
      && hdiutil convert "$raw_dmg" -format UDZO -ov -o "$temp_dmg" >>"$FALLBACK_LOG" 2>&1 \
      && hdiutil verify "$temp_dmg" >>"$FALLBACK_LOG" 2>&1; then
      cat "$FALLBACK_LOG"
      mv -f "$temp_dmg" "$DMG_PATH"
      return 0
    else
      status=$?
      cat "$FALLBACK_LOG" >&2
      rm -f "$raw_dmg" "$temp_dmg"
    fi

    if ! grep -Eiq 'device not configured|resource busy|resource temporarily unavailable|timed out' "$FALLBACK_LOG"; then
      echo "hdiutil failed with a non-retryable error (exit $status)." >&2
      break
    fi

    if (( attempt < max_attempts )); then
      echo "hdiutil reported a transient device error; retrying in ${retry_delay}s." >&2
      sleep "$retry_delay"
      retry_delay=$((retry_delay * 2))
    fi
  done

  echo "hdiutil could not create a valid DMG after $attempt attempt(s)." >&2
  echo "Disk image attachments at failure:" >&2
  hdiutil info >&2 || true
  echo "Available space at failure:" >&2
  df -h /private/tmp "$DMG_DIR" >&2 || true
  return "$status"
}

DMG_READY=0
if [[ -s "$DMG_PATH" ]]; then
  echo "==> Verifying the Tauri DMG"
  if hdiutil verify "$DMG_PATH"; then
    DMG_READY=1
  else
    echo "Tauri left an invalid DMG; creating a fresh fallback image." >&2
    rm -f "$DMG_PATH"
  fi
fi

if (( DMG_READY == 0 )); then
  create_fallback_dmg
fi

echo "==> Verifying the DMG"
hdiutil verify "$DMG_PATH"

echo "==> Opening the installer window"
open "$DMG_PATH"

echo ""
echo "DMG ready: $DMG_PATH"
echo "Finder should now show beta-life.app and the Applications shortcut."
