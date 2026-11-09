# Beta Life Agent Instructions

Before changing frontend UI, read `DESIGN.md` and inspect the nearest existing Settings or AI Provider surface for typography, control height, padding, and spacing. Treat the design contract as a repository-level constraint, not a suggestion.

When adding a new form, use the shared CSS tokens and component patterns. Do not introduce page-specific spacing values to compensate for a missing parent gap. When a list can grow, prefer step navigation with one expanded editor.

For AI features, keep prompts in `AppSettings.ai`, preserve structured response validation in the Rust command, and make language behavior follow the input content. Never write AI output directly into confirmed data without an explicit user confirmation step.

For activity tracking (foreground window, AFK detection, browser domains, event storage, timeline views), use ActivityWatch (https://github.com/ActivityWatch/activitywatch) as the implementation reference, especially `aw-watcher-window`, `aw-watcher-afk`, `aw-watcher-web`, `aw-server-rust` (event model and heartbeat merging), and `aw-webui`. Before designing one of these pieces, study how ActivityWatch solves it, then implement our own improved version inside Beta Life's Rust and React code; do not add ActivityWatch as a runtime dependency. ActivityWatch is MPL-2.0: borrow designs and ideas, but do not copy its source files or substantial code verbatim. When you find an ActivityWatch bug, an open issue we could fix, or an improvement worth upstreaming, proactively tell the user and propose a concrete PR (repo, problem, fix sketch); never open issues or PRs without the user's approval.

Before handoff, run the frontend checks, Rust tests, and production build. Report any visual inspection that could not be performed separately from automated checks.

Every task ends with a local test build: after the requested changes and the checks above pass, run `scripts/build-mac-clean.sh` so the user can install the DMG and test locally. Do not hand off a task without running it, and report the resulting DMG path or the failure output.
