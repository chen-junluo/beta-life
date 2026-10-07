# Beta Life UI Contract

This is the source of truth for new UI work in Beta Life. Read it before adding or substantially changing a surface.

## Spacing

- Use the shared CSS tokens in `src/styles.css`: `--ui-field-gap` for the gap after a field, and `--ui-section-gap` for the gap between sections.
- A form field is a label, helper text when present, and one control. Keep the label-to-control relationship intact; do not repair a layout with a one-off negative margin.
- The standard sheet content padding is `20px 21px 22px`. A two-column field row needs the same bottom gap as a single field row before the next section.
- Keep section headings, helper text, controls, and action rows on the same spacing rhythm. If a new component needs a different rhythm, add a named token or component rule rather than an isolated pixel value.

## Type And Controls

- Match the existing Settings and AI Provider hierarchy: field labels use the compact semibold label style, controls use the shared input height and 12-13px body size, and helper text stays one step smaller and muted.
- Reuse the shared button, input, select, panel, and focus styles. New controls should not invent a second radius, shadow, or font scale.
- Keep color as visual reinforcement, not the only meaning. Statuses need accessible text or an `aria-label`.

## Long Content

- Long lists of editable items use step navigation plus one expanded editing panel. Do not stack every editable item vertically when a user needs to review them one by one.
- Long labels in navigation are truncated inside stable-width controls; the full value remains available through the control title or the expanded panel.

## Verification

- Run `npm run check`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `npm run build` after UI or data-contract changes.
- For spacing changes, inspect the affected sheet at a normal desktop width and a narrow width. Check label-to-control gaps, section-to-section gaps, action-row alignment, and whether long content pushes later controls off-screen.
