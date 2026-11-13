# ServiceLedger design system

The reference for building ServiceLedger screens: the rules below, the tokens in `tokens.json`, and the component styles in `components.css`. It is exported from the claude.ai Design System artifact "ServiceLedger" (synced from `frontend/src/index.css` and `frontend/src/styles/` at `main@82aae57`, 2026-11-13). The app's own CSS stays the source of truth: if `frontend/src/index.css` and `tokens.json` disagree, the app wins and this folder is out of date (`check_tokens.py` compares the colour tokens in the first `:root` block and in `:root[data-theme='dark']`; it skips the duplicate dark values inside `@media (prefers-color-scheme: dark)`, and spacing, radius, type, shadows and fonts, which are checked by hand).

Use this system to build screens for ServiceLedger, a document-first service ledger for lab instruments: a lab manager uploads a scanned service report, the app reads it, and the person checks and finalizes it. The audience is core facility managers, so the interface is calm, dense with facts and never decorative.

## Content fundamentals

- Write plain words in sentence case: "Review & finalize", "Take a photo or choose a file", "3 fields need your attention". Show progress as Upload, Classify, Review & finalize, never as job states.
- Address the person as "you" and name the thing: "Check it against the form." No exclamation marks, no emoji, no marketing tone.
- Say what happened instead of showing a number that is not a measurement: a confidence percentage appears only where a model produced it; otherwise write "read from document text", "from task code", "demo value" or "not found".
- Errors say what went wrong and what to do next. Destructive buttons name the action ("Delete report"), and the confirming step repeats it.
- Dates are shown with day, short month and year (`toLocaleDateString` with `day: 'numeric', month: 'short', year: 'numeric'`), so the order and spelling follow the browser's locale, for example "4 Dec 2026" or "Dec 4, 2026". Serial numbers and task codes use `mono`.

## Visual foundations

- **Colour.** Indigo is the only brand colour: `accent-fill` for the primary button and bars, `accent` for links and focus, `accent-soft` for selected and informational grounds. Amber (`flag`, `flag-soft`, `warn-soft`) means "needs a second look" everywhere and is never decoration. Green (`good`, `good-soft`) means finalized or healthy only. Red (`crit`, `crit-soft`) means destructive or failed only. Body text is `text` on `bg` and `surface`; secondary text `text-muted`; hints `text-faint`.
- **Light and dark.** Both themes ship; the app follows the device until the person presses the toggle. Dark is a soft slate-blue (`bg` #232a3b), not near-black, and surfaces get lighter as they rise: `bg`, `surface`, `surface-2`. The scan image stays on `paper` in both themes.
- **Type.** `IBM Plex Sans` for UI, `IBM Plex Mono` for serials and codes. Body text inherits the browser's 16px (`body` sets no size), and components set their own sizes in rem: buttons 0.82rem, inputs and selects 0.88rem. The `text-*` variables exist in `index.css`, but `--text-base` (15px) is not used anywhere in the app today. Headings use weight 600; section labels are `section-label` (uppercase, `text-faint`).
- **Shape.** `radius-sm` (8px) for buttons, inputs and fields, `radius` (14px) for cards and the app frame, `radius-pill` for badges, pills and toasts. Cards sit on `bg` with a 1px `border` and `shadow`; menus use `shadow-menu`, toasts `shadow-pop`.
- **Spacing.** Steps `space-1…6` (4, 8, 12, 16, 24, 32). Touch targets, buttons and inputs on phones are at least 44px high. Inputs keep their 0.88rem text on phones; there is no 16px rule, so iOS Safari may zoom in on focus.
- **Flagged fields** use a 4px `flag` left bar, the `flag-soft` fill and a text label together, never colour alone.
- **Charts.** One indigo hue with thin 8px bars, 4px rounded ends and direct labels; keyed multi-series lines use `series-1…5` in that fixed order.
- **Focus.** A 2px solid `accent` outline, offset 2px (1px on inputs), visible on every interactive element.
- **Motion.** Almost none: a short 8px toast rise, disabled under reduced motion.

## Iconography

There is no icon font, sprite or icon package. Icons are small inline SVG outlines drawn in the code: the tab icons (Home, New report, Reports, Analytics, Templates, Instruments, More) in `TabIcon` (`frontend/src/App.tsx` today; SL-56, PR #308, moves it into a new `TopbarTabs` component), 24×24 view box, `stroke="currentColor"`, 1.8px stroke, round caps and joins, no fill. The document-glyph mark (`frontend/public/favicon.svg`) uses the same style. A few text glyphs are used as icons: ☾ and ☀ in the theme toggle, "⋯" in row menus, "↓" in "Next ↓". A few symbols already appear in the app: 📄 in the New report drop zone, ✓ in the step bar and finished screens, ⚠ in saved filters. Do not add more emoji or an icon set without asking; draw a new icon as an outline in the same style as the tab icons.

## Components

Button, Badge, StatusPill, Notice, Field, ThemeToggle, Toast, RowMenu and BarRow have static renditions in the artifact, styled by `components.css` (the `sl-` classes) from the tokens. In the app they are the components listed under `meta.components` in `tokens.json`; build with those, not with the `sl-` classes.

## Not included

The fonts (the app loads them from the `@fontsource` packages), the artifact's component preview pages and its own metadata. Not brought into the design system at all: the app's screen-level components (about 50, tied to the API) and the mock boards in `docs/mockups`.

