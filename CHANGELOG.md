# Changelog

## 0.5.0 - 2026-10-29

- Added the Memories view with a 3D Memory Constellation, memory creation sheet, editor, and insights.
- Added Rust commands for persisting memories and AI-assisted memory parsing, with a configurable memory analysis prompt in Settings.

## 0.4.0 - 2026-10-26

- Added the Ability Forest view with a default skill map, map editing, and progress tracking.
- Added Rust commands and persistent state for Ability Forest data.

## 0.3.0 - 2026-10-12

- Added random-question, AI spot-check, and full-recall modes scoped to the visible knowledge list.
- Reduced quiz distractions by hiding the memory curve through answering and feedback confirmation, then returning to the last reviewed knowledge item.
- Renamed the desktop app and macOS installer to `beta-life`.

## 0.2.4 - 2026-10-09

- Fixed Rust formatting validation so release workflows can proceed to tests and packaging.

## 0.2.3 - 2026-10-09

- Refined the app icon spacing so the four-panel mark fills more of its white canvas.

## 0.2.2 - 2026-10-09

- Replaced the app icon with the centered four-panel life-window mark.

## 0.2.1 - 2026-10-09

- Added the slide-out workspace drawer for switching between the time board and Recall.
- Added 20 standalone logo concepts and a comparison gallery.

## 0.2.0 - 2026-10-09

- Added Markdown-based Recall notes, checkpoint review, confirmed feedback, and hierarchical tags.
- Added FSRS-powered scheduling, memory-curve history, and deletion of individual review results.
- Added configurable recall prompts and target retention.

## 0.1.0 - 2026-09-20

- Initial Beta Life desktop release.
- Added the four-period life board, focused period views, exact-hour placement, and drag-and-drop organization.
- Added local autosave, undo/redo, appearance settings, and Board JSON import/export.
- Added review-before-import AI extraction through DeepSeek and custom OpenAI-compatible providers.
- Added macOS and Windows release packaging through GitHub Actions.
