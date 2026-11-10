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
  local info device
  # Capture first: awk exits on the first match, which would SIGPIPE a piped
  # hdiutil and fail the script under pipefail while the old DMG is mounted.
  if ! info="$(hdiutil info)"; then
    echo "Could not inspect attached disk images; refusing to replace $DMG_PATH." >&2
    return 1
  fi
  device="$(awk -v target="$DMG_PATH" '
    /^image-path[[:space:]]*:/ {
      path = $0
      sub(/^[^:]*:[[:space:]]*/, "", path)
      matches = (path == target)
      next
    }
    matches && $1 ~ /^\/dev\/disk[0-9]+$/ { print $1; exit }
  ' <<<"$info")"

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
STRIP_DIR=""
CHECK_DIR=""
cleanup_fallback_files() {
  if [[ -n "$CHECK_DIR" ]]; then
    hdiutil detach "$CHECK_DIR" -force >/dev/null 2>&1 || true
    rm -rf "$CHECK_DIR" || true
  fi
  if [[ -n "$STRIP_DIR" ]]; then
    hdiutil detach "$STRIP_DIR/mnt" -force >/dev/null 2>&1 || true
    rm -rf "$STRIP_DIR" || true
  fi
  [[ -z "$FALLBACK_STAGE_DIR" ]] || rm -rf "$FALLBACK_STAGE_DIR" || true
  [[ -z "$FALLBACK_IMAGE_DIR" ]] || rm -rf "$FALLBACK_IMAGE_DIR" || true
  [[ -z "$FALLBACK_LOG" ]] || rm -f "$FALLBACK_LOG" || true
}
# Local code signing. Ad-hoc signatures change on every build, so macOS drops the
# Accessibility and Automation grants that activity capture needs. A self-signed
# "Beta Life Local" identity keeps the designated requirement (bundle id + this
# certificate) stable, so a grant survives reinstalls. The identity lives in its
# own keychain with a generated password, so codesign never shows a keychain
# prompt; the keychain is on the search list only while this script runs.
SIGN_NAME="Beta Life Local"
SIGN_DIR="$HOME/Library/Application Support/beta-life-signing"
SIGN_KEYCHAIN="$HOME/Library/Keychains/beta-life-local-signing.keychain-db"
ORIGINAL_KEYCHAINS=()

create_local_signing_identity() {
  echo "==> Creating the local signing identity \"$SIGN_NAME\" (one time)"
  local work password p12_password
  work="$(mktemp -d /private/tmp/beta-life-sign.XXXXXX)"
  password="$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"
  p12_password="$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"
  cat > "$work/cert.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $SIGN_NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
  # macOS LibreSSL writes a PKCS#12 that `security import` accepts (OpenSSL 3 defaults do not).
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$work/cert.cnf" \
    -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
  /usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" \
    -out "$work/identity.p12" -passout "pass:$p12_password"
  security create-keychain -p "$password" "$SIGN_KEYCHAIN"
  security set-keychain-settings "$SIGN_KEYCHAIN"
  security unlock-keychain -p "$password" "$SIGN_KEYCHAIN"
  security import "$work/identity.p12" -k "$SIGN_KEYCHAIN" -P "$p12_password" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$SIGN_KEYCHAIN" >/dev/null
  (umask 077 && printf '%s' "$password" > "$SIGN_DIR/keychain-password")
  rm -rf "$work"
}

use_local_signing_identity() {
  mkdir -p "$SIGN_DIR"
  chmod 700 "$SIGN_DIR"
  if [[ ! -f "$SIGN_KEYCHAIN" || ! -f "$SIGN_DIR/keychain-password" ]]; then
    create_local_signing_identity
  fi
  security unlock-keychain -p "$(cat "$SIGN_DIR/keychain-password")" "$SIGN_KEYCHAIN"
  local line
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%\"}"
    ORIGINAL_KEYCHAINS+=("${line#\"}")
  done < <(security list-keychains -d user)
  # codesign only finds identities in keychains on the user search list.
  security list-keychains -d user -s "$SIGN_KEYCHAIN" "${ORIGINAL_KEYCHAINS[@]}"
  APPLE_SIGNING_IDENTITY="$(security find-identity -p codesigning "$SIGN_KEYCHAIN" \
    | awk -v name="\"$SIGN_NAME\"" 'index($0, name) { print $2; exit }')"
  if [[ -z "$APPLE_SIGNING_IDENTITY" ]]; then
    echo "The \"$SIGN_NAME\" identity is missing from $SIGN_KEYCHAIN." >&2
    exit 1
  fi
  export APPLE_SIGNING_IDENTITY
  echo "==> Signing with \"$SIGN_NAME\" ($APPLE_SIGNING_IDENTITY)"
}

restore_keychain_search_list() {
  if (( ${#ORIGINAL_KEYCHAINS[@]} > 0 )); then
    security list-keychains -d user -s "${ORIGINAL_KEYCHAINS[@]}" || true
    ORIGINAL_KEYCHAINS=()
  fi
}

trap 'cleanup_fallback_files; restore_keychain_search_list' EXIT

echo "==> Cleaning generated caches and build output"
rm -rf "$ROOT_DIR/dist" "$ROOT_DIR/node_modules/.vite"
cargo clean --manifest-path "$ROOT_DIR/src-tauri/Cargo.toml"
mkdir -p "$DMG_DIR"
rm -f "$DMG_PATH"

use_local_signing_identity

echo "==> Building the macOS application and DMG"
BUILD_EXIT=0
if LC_ALL=C LANG=C npm run build:mac; then
  :
else
  BUILD_EXIT=$?
  echo "Tauri's DMG bundler did not finish; continuing with the direct DMG fallback."
fi
restore_keychain_search_list

if [[ -d "$APP_PATH" ]] && ! codesign -dv "$APP_PATH" 2>&1 | grep -q "Authority=$SIGN_NAME"; then
  echo "The app was not signed with \"$SIGN_NAME\"; macOS privacy grants would not survive this build." >&2
  exit 1
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

# Tauri always passes --volicon to bundle_dmg.sh, which leaves .VolumeIcon.icns
# in the volume root. Finder shows it whenever hidden files are visible, so drop
# it to keep the installer window to the app and the Applications shortcut.
strip_volume_icon() {
  STRIP_DIR="$(mktemp -d /private/tmp/beta-life-dmg-strip.XXXXXX)"
  local rw_dmg="$STRIP_DIR/rw.dmg"
  local mount_dir="$STRIP_DIR/mnt"
  local clean_dmg="$STRIP_DIR/$(basename "$DMG_PATH")"

  echo "==> Removing the volume icon from the installer window"
  hdiutil convert "$DMG_PATH" -format UDRW -o "$rw_dmg" -quiet
  mkdir "$mount_dir"
  hdiutil attach "$rw_dmg" -nobrowse -noverify -noautoopen -mountpoint "$mount_dir" -quiet
  rm -f "$mount_dir/.VolumeIcon.icns"
  SetFile -a c "$mount_dir"
  hdiutil detach "$mount_dir" -quiet
  hdiutil convert "$rw_dmg" -format UDZO -imagekey zlib-level=9 -o "$clean_dmg" -quiet
  mv -f "$clean_dmg" "$DMG_PATH"
  rm -rf "$STRIP_DIR"
  STRIP_DIR=""
}

DMG_READY=0
if [[ -s "$DMG_PATH" ]]; then
  echo "==> Verifying the Tauri DMG"
  if hdiutil verify "$DMG_PATH"; then
    strip_volume_icon
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

# Finder coordinates of the approved, centered installer layout. They come from
# the dmg appPosition / applicationFolderPosition in src-tauri/tauri.conf.json
# ({160,125} and {460,125}); Tauri's bundler shifts them by {+20,+45}.
EXPECTED_LAYOUT="beta-life.app 180 170
Applications 480 170"

verify_installer_layout() {
  echo "==> Verifying the installer window layout"
  CHECK_DIR="$(mktemp -d /private/tmp/beta-life-dmg-check.XXXXXX)"
  hdiutil attach "$DMG_PATH" -readonly -nobrowse -noverify -noautoopen -mountpoint "$CHECK_DIR" -quiet

  local volume_icon=0 layout=""
  [[ ! -e "$CHECK_DIR/.VolumeIcon.icns" ]] || volume_icon=1
  if [[ -f "$CHECK_DIR/.DS_Store" ]]; then
    # Iloc records in .DS_Store: UTF-16BE file name, "Ilocblob", length, x, y.
    layout="$(python3 -I - "$CHECK_DIR/.DS_Store" <<'EOF'
import re, struct, sys
data = open(sys.argv[1], "rb").read()
for match in re.finditer(rb"Ilocblob", data):
    start = match.start()
    for length in range(1, 128):
        name_start = start - 2 * length
        if name_start < 4:
            break
        if struct.unpack(">I", data[name_start - 4:name_start])[0] == length:
            x, y = struct.unpack(">II", data[start + 12:start + 20])
            name = data[name_start:start].decode("utf-16-be")
            if name in ("beta-life.app", "Applications"):
                print(name, x, y)
            break
EOF
)"
    layout="$(sort <<<"$layout")"
  fi
  hdiutil detach "$CHECK_DIR" -quiet
  rm -rf "$CHECK_DIR"
  CHECK_DIR=""

  if (( volume_icon )); then
    echo "The installer still contains .VolumeIcon.icns." >&2
    exit 1
  fi
  if [[ "$layout" != "$(sort <<<"$EXPECTED_LAYOUT")" ]]; then
    if (( DMG_READY == 0 )); then
      echo "Warning: the fallback DMG uses Finder's default icon layout, not the centered one." >&2
      return 0
    fi
    echo "The installer icons are not in the centered layout." >&2
    echo "Expected:" >&2; echo "$EXPECTED_LAYOUT" >&2
    echo "Found:" >&2; echo "${layout:-<none>}" >&2
    exit 1
  fi
}

verify_installer_layout

echo "==> Opening the installer window"
open "$DMG_PATH"

echo ""
echo "DMG ready: $DMG_PATH"
echo "Finder should now show beta-life.app and the Applications shortcut."
