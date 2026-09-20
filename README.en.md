# Beta Life

[中文说明](README.md)

Beta Life is a local-first desktop board for arranging habits around the rhythm of a day. Start with four flexible periods, then assign an exact hour only when it is useful.

## Download

Download the app from [GitHub Releases](https://github.com/chen-junluo/beta-life/releases):

- macOS (Apple Silicon and Intel): `.dmg`
- Windows: `.msi` is recommended; an NSIS `.exe` installer is also available

### Installing the unsigned macOS build

The current macOS build has no Apple Developer ID signature and is not notarized. Open the `.dmg` and drag `Beta Life.app` to `Applications` first.

If macOS reports that the app is damaged or refuses to open it, run:

```bash
xattr -dr com.apple.quarantine "/Applications/Beta Life.app"
open "/Applications/Beta Life.app"
```

This path is intended for developer users and small-scale testing. It is not yet a no-warning installation path for general users. Run the command only for an app downloaded from this repository's Releases page whose source you trust.

## What it does

- Shows morning, afternoon, evening, and sleep periods in one global view
- Provides a focused view for each period
- Places habits in a broad period or at an exact hour, with drag-and-drop rearrangement
- Stores descriptions, tags, and source excerpts with each habit
- Customizes period boundaries, colors, slogans, card width, type sizes, and interface zoom
- Autosaves locally, with undo, redo, and Board JSON import/export
- Extracts reviewable habit suggestions from text or images through DeepSeek or a custom OpenAI-compatible endpoint

AI suggestions are never written to the board automatically. You review, edit, and select them before import.

## Data and privacy

The board and settings stay in the operating system's application-data directory. API keys are stored in macOS Keychain or encrypted for the current Windows user with DPAPI. Board JSON exports exclude API keys, provider settings, and custom prompts.

Text, images, and the relevant conversation context are sent to the configured external AI provider only when you use AI extraction. The provider's own policies govern its processing and retention.

Typical data directories:

- macOS: `~/Library/Application Support/com.dylanchen.beta-life/`
- Windows: `%APPDATA%\com.dylanchen.beta-life\`

Importing a Board JSON file replaces the current board. The app keeps a pre-import backup in its data directory, but a manual export is still recommended.

## Development

Install Node.js 22, Rust stable, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
npm ci
npm run tauri -- dev
```

Checks:

```bash
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

Platform builds:

```bash
npm run build:mac
npm run build:windows
```

`build:mac` runs only on macOS, and `build:windows` runs only on Windows. Pushing a tag such as `v0.1.0` triggers GitHub Actions to build a universal macOS DMG plus Windows MSI and NSIS installers and publish them to Releases.

## Stack

React 19, TypeScript, Vite, Rust, and Tauri 2.
