# Beta Life Agent Instructions

Before changing frontend UI, read `DESIGN.md` and inspect the nearest existing Settings or AI Provider surface for typography, control height, padding, and spacing. Treat the design contract as a repository-level constraint, not a suggestion.

When adding a new form, use the shared CSS tokens and component patterns. Do not introduce page-specific spacing values to compensate for a missing parent gap. When a list can grow, prefer step navigation with one expanded editor.

For AI features, keep prompts in `AppSettings.ai`, preserve structured response validation in the Rust command, and make language behavior follow the input content. Never write AI output directly into confirmed data without an explicit user confirmation step.

Before handoff, run the frontend checks, Rust tests, and production build. Report any visual inspection that could not be performed separately from automated checks.
