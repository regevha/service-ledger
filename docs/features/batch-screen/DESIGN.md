# Batch screen: files grouped by status (SL-60)

Design brief for the "Several PDFs" screen (`#/batch`, `frontend/src/components/BatchIntake.tsx`).
Owner of this file: ux-reviewer. Builder: frontend-dev. No backend change.

## 1. Why

The owner dropped 11 files and got 11 rows that all look the same. Four rows said the same two sentences and had the
same two buttons ("This exact file was already read." / "Already on file" / "Open it" / "Remove"). To clear them took
four clicks. The header said "4 need you" when those four needed nothing. Two Hebrew file names showed with their parts
in the wrong order.

What we checked on the running app (stub mode, synthetic files, 2026-11-13). Screenshots:

- `/tmp/sl60-shots/before-1-waiting-1400.png`, `before-1-waiting-390.png`: files waiting
- `/tmp/sl60-shots/before-2-reading-1400.png`, `before-2-reading-390.png`: reading
- `/tmp/sl60-shots/before-3-mixed-1400.png`, `before-3-mixed-390.png`, `before-3-mixed-1400-dark.png`: 11 files in five states

Problems found, in order of harm:

1. **Wrong count.** `summarize().stopped` counts "already on file" as "need you". With 4 duplicates and 2 failures
   the header says "6 need you". Nothing about a duplicate needs the person.
2. **Repeated text.** The same sentence and the same buttons on every duplicate row. The eye cannot find the rows
   that matter.
3. **No group actions.** Clearing 4 duplicates, or 3 failures, is one click per file.
4. **No order.** Rows stay in drop order. A file that is ready to check can sit below ten that are done.
5. **Hebrew names.** No bidi isolation. A name like `(1) 080925 <Hebrew words>.pdf` shows its parts in an order a
   Hebrew reader does not expect.
6. **Long names.** Full names wrap to three lines on a phone. Names that differ only at the end (`... (2).pdf`,
   `... (3).pdf`) look alike.
7. **"Try again" that cannot help.** A file refused as the wrong type (415), too large (413) or unreadable (422) still
   offers "Try again". It fails again the same way.
8. **"Stop" makes failures.** Stopped files become "Failed" with "Stopped." They were not wrong: they were just not read.
9. **Technician field is unstyled.** The input has no `type="text"` and no class, so the shared input style does not
   apply (thin grey box, 13 px). It is labelled "Technician" here, "Your name" on New report and "Lab manager" in the
   report lists.
10. **Contrast.** "6 need you" is `--flag` (#b57308) on white: 3.9:1. Below 4.5:1 for 16 px text.
11. **Undefined tokens.** The batch CSS uses `var(--muted)` and `var(--ok)`. Neither exists in `index.css`, so the
    muted colour and the grey state pill silently fall back to inherited values.
12. **Two primary buttons** side by side ("Read 3 files" and "Check next"). Neither is clearly the next step.
13. The drop zone stays full size (100 px high) after files are in, and pushes the list down.

## 2. Flow

Goal: turn a pile of PDFs into reports, each checked and approved.

1. The person drops files on Home (or New report, or this screen). The screen opens with every file in **Waiting**.
2. They may type their name. They press **Read 7 files**.
3. Files move into **Reading now** (two at a time) and then out into one of: **Ready to check**, **Needs you**,
   **Could not read**, **Already on file**.
4. When reading ends, a short line says what happened: "Done. 3 ready to check, 1 needs you, 4 already on file."
5. They press **Check next**. The report screen opens. They check and approve it there, and come back (Back, or the
   report screen's own way back). The file now shows under **Approved**.
6. Repeat until **Ready to check** is empty.
7. Clean up: **Remove all 4** under Already on file, **Remove all 2** under Could not read. An Undo line appears.

Failure paths:

- **Wrong file type at drop** (not a PDF or image): left out at once, warning banner (unchanged copy).
- **More than 30 files**: the rest are left out, warning banner (unchanged copy).
- **Refused at upload (413, 415, 422)**: goes to Could not read with the server's reason. No Try again.
- **Fails while reading** (job failed, network): goes to Could not read with the reason. Try again is offered.
- **Hebrew form, or instrument and form not recognised**: goes to Needs you with the reason. The person uploads it on
  its own in New report.
- **Same bytes already read**: goes to Already on file, with a way to open that report.
- **Stop pressed**: files being read are cancelled and go back to Waiting. Nothing is lost; Read starts them again.
- **The person leaves the screen**: unchanged. The screen stays mounted and keeps the list.

## 3. Where it lives

Same place: `#/batch`, the New report tab stays active. Same header ("Several PDFs", Back to New report). The list
below the header is replaced by groups.

New CSS goes in `frontend/src/styles/13-batch-screen.css`, imported from `App.css` (check the braces balance). Move the
`.batch-*` rules out of `10-pdf-picker-and-home.css` into it so the screen has one file. Components may be split
under `frontend/src/components/batch/` (for example `BatchGroup.tsx`, `BatchRow.tsx`, `UndoNotice.tsx`).

## 4. Layout (desktop, 1400 px)

```
Several PDFs                                                        [Back to New report]
Each file is read on its own. You check and approve each one on its report screen.

┌ Add more files: drop them here, or choose them. Up to 30 in all. ┐   (compact once files are in)

Your name (optional) [______________]  Saved on each report read from this list.

11 files: 2 ready to check · 1 needs you · 2 could not be read · 4 already on file · 2 waiting
                                                       [Read 2 files]  [Check next (2 left)]

▾ Ready to check  2                                                                    
   Read and waiting for you. Check each one and approve it on its report screen.
   Example_Service_Report_Aurora_2026-03-02.pdf      CytoFLEX S · Preventive maintenance   [Check]
   example-fortessa-visit.pdf                        LSRFortessa · Preventive maintenance  [Check]

▾ Needs you  1
   This screen cannot finish these. Upload each one on its own in New report.
   scan-unknown-form.pdf        Could not tell the instrument and form. ...                  

▾ Could not read  2                                                     [Try all again] [Remove all 2]
   broken-file.pdf              Unsupported file type. Upload a PDF or ...       [Remove]
   network-blip.pdf             Reading the fields failed.                      [Try again] [Remove]

▸ Already on file  4                                                                   [Remove all 4]
   (closed by default; the note sits under the heading when opened)

▾ Waiting  2                                                                          [Remove all 2]
   Example_Work_Order_Servi…Label_v3 (3).pdf    80 KB                                      [Remove]
   (1) 080925 <Hebrew>.pdf                     79 KB                                      [Remove]

▸ Approved  1
```

### 4.1 Groups

One group per status. Only groups with at least one file are shown. Fixed order, most useful first:

| # | Group heading | Item states | Open by default | Group note (shown once, under the heading) | Group actions | Row actions |
|---|---|---|---|---|---|---|
| 1 | Ready to check | `ready` | open | Read and waiting for you. Check each one and approve it on its report screen. | none (Check next is in the top bar) | **Check** (`btn small primary`) |
| 2 | Needs you | `attention` | open | This screen cannot finish these. Upload each one on its own in New report. | **Remove all N** | none |
| 3 | Could not read | `failed` | open | none (reasons differ, shown per row) | **Try all again** (only if at least one can be retried; disabled while reading), **Remove all N** | **Try again** (only if it can be retried), **Remove** |
| 4 | Reading now | `uploading`, `language`, `identifying`, `reading` | open | none | none | none |
| 5 | Waiting | `queued` | open | none | **Remove all N** (hidden while reading) | **Remove** (hidden while reading) |
| 6 | Already on file | `duplicate` | **closed** | These exact files were read before, so they were not read again. There is nothing to do: remove them from this list, or open the report that has each one. | **Remove all N** | **Open report** (`btn small`) |
| 7 | Approved | `approved` | **closed** | none | none | **Open** (`btn small`) |

Rules:

- **One message per group, not per row.** A row shows its own reason only when it differs from the others. Build rule:
  if every row in the group has the same `message`, show that message once as the group note and none on the rows.
  Otherwise show each row's message on its row. (The fixed notes in the table above replace the per-row message
  for Already on file and Needs you's generic part; Needs you rows still show their own reason, which differs:
  "A Hebrew form ..." vs "Could not tell the instrument and form ...".)
- **No status pill on rows.** The group says the status. Exception: rows in **Reading now** show their step
  ("Uploading", "Checking language", "Identifying", "Reading fields") with the existing pulsing dot
  (`.batch-state.working`), because the step changes.
- **Row detail line** (muted, `--text-sm`): Ready and Approved: instrument · report type (as today). Waiting:
  size ("79 KB"). Reading: the step. Needs you and Could not read: the reason. Already on file: nothing.
- **Inside a group**, rows keep the order the files were dropped (by `id`).
- **Open and closed** is remembered while the screen stays mounted (component state keyed by group). The two
  defaults that are closed (Already on file, Approved) open when the person opens them and stay open.
  A group that becomes empty disappears; if it later gets files again it uses its default.
- **Ready-to-check rows have no Remove.** They are already a draft report on the server. Removing them here would
  hide a draft, not delete it. Discarding a draft stays on the report screen. (No change from today.)

### 4.2 Group heading

- A `<section aria-labelledby=...>` per group. The heading is an `<h2>` that contains one `<button type="button"
  aria-expanded aria-controls>`. Same disclosure pattern as `ChartSection.tsx` (`chart-toggle`): the label, then
  the count, then a chevron `▾` / `▸` with `aria-hidden="true"`.
- Button text (what a screen reader reads): "Ready to check, 2 files". On screen: "Ready to check" + a count pill "2".
- Group actions sit to the right of the heading on the same line (outside the toggle button, never inside it).
- Look: reuse the card look of `.report-group` / `.report-group-head` from `09-reports-grouped-and-reading.css`
  (`--surface`, `--border`, `--radius`, head on `--surface-2`). The groups stack with `gap: var(--space-3)`.
- Count pill: base `.status-pill` shape (it already exists: 0.75rem, 600, pill radius), but with `text-transform: none`
  and these colours (new classes in `13-batch-screen.css`; no new tokens):

| Group | Pill background / text | Light | Dark |
|---|---|---|---|
| Ready to check | `--accent-soft` / `--accent-strong` | 8.1:1 | 7.5:1 |
| Needs you | `--warn-soft` / `--warn` | 6.1:1 | 7.4:1 |
| Could not read | `--crit-soft` / `--text` | 13.5:1 | 11.5:1 |
| Reading now, Waiting, Already on file | `--surface-2` / `--text-muted` | 5.6:1 | 5.7:1 |
| Approved | `--good-soft` / `--good` | 6.9:1 | 6.3:1 |

- A left bar on the group card shows the colour, as banners do: `box-shadow: inset 4px 0 0 var(--accent)` for Ready,
  `var(--flag)` for Needs you, `var(--crit)` for Could not read, `var(--good)` for Approved, none for the others.
  Colour is never the only signal: the heading words carry the meaning.

### 4.3 Rows

- Grid: name and detail on the left (`minmax(0, 1fr)`), actions on the right (`auto`). Row padding
  `var(--space-2) var(--space-4)`, divider `1px solid var(--border)`, no divider after the last row.
- **File name**: one line, weight 600.
  - Shortened in the middle, so the end (`(3).pdf`) stays visible. A pure helper in `batchState.ts`:
    `shortName(name: string, max = 48): string`. If the name has at most `max` characters, return it. Otherwise
    return the first `max - 15` characters, then `…`, then the last 14 characters. Unit-test it in
    `batchState.test.ts` (short name unchanged; long name keeps start and the `(3).pdf` end; exactly `max` unchanged).
  - Full name in `title` (hover) and in the accessible names of the row's buttons.
  - **Bidi:** wrap the name in `<bdi>` (it isolates and picks its direction from the first strong letter, like
    `dir="auto"`). The outer span stays left-aligned, so a Hebrew name reads right to left inside its own box and does
    not reorder the English around it. Also on every place the name appears in text: the Undo line, button labels.
    Add `unicode-bidi: isolate` on `.batch-name` as a fallback.
  - On a phone, allow two lines (`-webkit-line-clamp: 2`) instead of one, with the same middle shortening.
- Per-row buttons are `btn small`. Accessible names include the file: `aria-label="Check <full name>"`,
  `"Remove <full name> from this list"`, `"Try <full name> again"`, `"Open the report that already has <full name>"`,
  `"Open the report for <full name>"`.

## 5. Top area

### 5.1 Drop zone

- No files yet: unchanged (big zone, "Drop PDFs here, or choose them" / "Up to 30 files. Each one becomes its own
  report.").
- Files in: compact one-line zone (`padding: var(--space-3) var(--space-4)`, same dashed border):
  "**Add more files:** drop them here, or choose them. Up to 30 in all." When 30 are in: the input is disabled and the
  text is "The list is full (30 files). Remove some to add more."
- Warning banners after a drop: unchanged copy and `banner banner-warn`, but placed inside the screen's padding
  (today it is inset 20 px further than everything else; see `before-2-reading-1400.png`).

### 5.2 Name field (today "Technician")

How it is used: the value goes to `createReport({ technician_name })` for every file read after it is typed. It is
stored on the report and shown as "Lab manager" in the report lists and on the report page. New report asks the same
thing as "Your name (optional)". It is a person's name, so it falls under "privacy first".

Design (pending the product question at the end):

- Keep it, renamed to match New report: label **Your name (optional)**, hint (`hint-text`) **Saved on each report read
  from this list.**
- Move it out of the counts line into its own line under the drop zone, above the summary. Show it only while there are
  files in Waiting (it has no effect on files already read). Disabled while reading, as today.
- Fix the input: `type="text" className="text-input"`, a real `<label htmlFor>`; width `min(320px, 100%)`;
  `font-size: 16px` at `max-width: 620px` (stops phone zoom); `autocomplete="name"`.

### 5.3 Summary line and main buttons

Summary (one line, `--text-base`, weight 600 for the total, normal for the rest, `--text-muted` separators):

- Format: `<N> files: ` + the non-zero parts in group order, joined with ` · `:
  "2 ready to check", "1 needs you", "2 could not be read", "1 reading now", "2 waiting", "4 already on file",
  "1 approved". One file: "1 file: ...".
- Each part is a link-style button (`link-button`) that opens and scrolls to its group and moves focus to its heading
  button. This also gives a phone user a way to jump past long groups.
- No part uses colour as text. (Fixes the 3.9:1 "need you".)
- Fix `summarize()`: duplicates are not counted as needing the person. Return one count per group:
  `{ total, ready, attention, failed, working, queued, duplicate, approved }`. Update the existing e2e helper
  assertion in `batch-upload.spec.ts` to the new shape.

While reading, a second line under the summary: **Reading 3 of 7…** (done = files that left Waiting and Reading in this
run; total = files in this run) with the existing `.spinner` at 18 px.

Main buttons (right of the summary on desktop; full-width row on a phone). Only one is primary at a time:

| Situation | Buttons |
|---|---|
| Files waiting, not reading | **Read N files** (`btn primary`; "Read 1 file" for one). If some are ready to check: **Check next (N left)** as `btn` (secondary). |
| Reading | **Stop reading** (`btn`). If some are ready to check: **Check next (N left)** as `btn primary`. |
| Nothing waiting or reading, some ready | **Check next (N left)** (`btn primary`). |
| Nothing waiting, reading or ready | No main button. The summary line ends the screen's work. If anything is in Needs you, the summary is followed by a `banner banner-info` (see 5.4). |

"Check next" opens the first ready file in drop order (as today).

### 5.4 End-of-run line and the all-done state

When a run ends (the pool finishes or Stop completes), show one `hint-text` line under the summary, replaced at the
next run: **Done. 2 ready to check, 1 needs you, 4 already on file.** (only non-zero parts; after Stop:
**Stopped. 3 files are back in Waiting.**)

When nothing is left to check or read and at least one file is approved:
`banner banner-info`: **All read files are approved.** + `btn small` **Clear this list** (removes every row, with the
same Undo as 6.2). If some are in Needs you: add the sentence **N files still need you: upload each one on its own in
New report.**

## 6. Group actions and Undo

### 6.1 What each action does

- **Remove all N** (Needs you, Could not read, Waiting, Already on file): takes those files off this list. Nothing on
  the server changes (their draft reports were already removed when they stopped; Waiting files were never sent).
- **Try all again** (Could not read): puts every retryable failed file back to Waiting and starts reading them (same as
  pressing Try again on each). Files that cannot be retried stay.
- **Remove** (row): the same for one file.

### 6.2 Undo instead of a confirm dialog

Removing here deletes nothing stored, so a confirm dialog would be one more click for no safety. Use an Undo line:

- After any remove, an inline notice appears directly above the groups, in place (not a toast: the toast has no
  button and fades). Classes: `banner banner-info banner-with-action`, `role="status"`.
- Copy names exactly what went:
  - One file: **Removed "<name>" from this list. Nothing was deleted.** [**Undo**]
  - Several, up to 3: **Removed 3 files from this list: "<a>", "<b>", "<c>". Nothing was deleted.** [**Undo**]
  - More than 3: **Removed 4 files that were already on file: "<a>", "<b>" and 2 more. Nothing was deleted.** [**Undo**]
    The group words: "that were already on file", "that need you", "that could not be read", "that were waiting".
  - Names use `shortName()` and `<bdi>`.
- **Undo** (`btn small`) puts the files back with their states and messages, in their old order (sort by `id`). Focus
  goes to the heading of the group they returned to.
- The notice stays until the next remove (which replaces it), the next drop, or the next Read. No timer.
- Focus after a remove: to the Undo button. (The removed button no longer exists; focus must not fall to `body`.)

## 7. State changes to build (frontend only)

In `batchState.ts` / `batchRun.ts`:

1. `summarize()` returns one count per group (5.3). `needsPerson()` unchanged.
2. A grouping helper: `groupOf(state): GroupKey` and `GROUP_ORDER`, plus labels and notes as constants (copy in
   section 9). Pure, unit-tested.
3. `BatchItem.canRetry?: boolean`. Set `false` when the upload is refused with 413, 415 or 422; Try again is hidden for
   those. Default (undefined) means it can be retried.
4. Stop: a file cancelled by Stop goes back to `queued` with no message (not `failed` / "Stopped."). The same for
   "Stopped before it started." The draft is still removed, as today.
5. `shortName()` (4.3).

Nothing else in `runItem` changes. No API change.

## 8. Phone (390 px)

- Groups full width, card radius as desktop. Heading toggle button at least 44 px high, full width; group actions on
  their own line under the heading, left-aligned (`.batch-group-actions`), so the toggle stays one tap target.
- Rows: name (two lines max) and detail on top; actions on one line under them, left-aligned. Buttons 44 px high (the
  shared phone rule in `06-filters-lists-responsive.css` already does this for `.btn.small`).
- Summary parts wrap. Main buttons: a full-width row, primary first.
- Bottom tab bar: the screen keeps enough bottom padding (`padding-bottom: 88px` at `max-width: 620px`) so the last row
  and the Undo notice are never under it.
- The Reading-now and Waiting groups can be long on a phone; the summary links (5.3) let the person jump.

## 9. Copy (all on-screen text)

| Where | Text |
|---|---|
| Title / sub | Several PDFs / Each file is read on its own. You check and approve each one on its report screen. (unchanged) |
| Back | Back to New report (unchanged) |
| Drop zone, empty | **Drop PDFs here, or choose them** / Up to 30 files. Each one becomes its own report. (unchanged) |
| Drop zone, files in | **Add more files:** drop them here, or choose them. Up to 30 in all. |
| Drop zone, full | The list is full (30 files). Remove some to add more. |
| Name label / hint | Your name (optional) / Saved on each report read from this list. |
| Summary | `<N> files: 2 ready to check · 1 needs you · 2 could not be read · 1 reading now · 2 waiting · 4 already on file · 1 approved` |
| Progress | Reading 3 of 7… |
| Main buttons | Read 1 file / Read N files · Stop reading · Check next (N left) |
| End of run | Done. 2 ready to check, 1 needs you, 4 already on file. / Stopped. 3 files are back in Waiting. |
| All approved | All read files are approved. · Clear this list |
| Still need you | N files still need you: upload each one on its own in New report. (1: "1 file still needs you: upload it on its own in New report.") |
| Group headings | Ready to check · Needs you · Could not read · Reading now · Waiting · Already on file · Approved |
| Group notes | Ready: Read and waiting for you. Check each one and approve it on its report screen. / Needs you: This screen cannot finish these. Upload each one on its own in New report. / Already on file: These exact files were read before, so they were not read again. There is nothing to do: remove them from this list, or open the report that has each one. |
| Group actions | Remove all N · Try all again |
| Row actions | Check · Open · Open report · Try again · Remove |
| Reading steps | Uploading · Checking language · Identifying · Reading fields (unchanged `STATE_LABEL`) |
| Undo | see 6.2 · Undo |
| Live region | see 10 |

Reasons per row keep today's wording from `batchRun.ts` (Hebrew form, could not tell the instrument and form, server
messages). Only the duplicate sentence moves to the group note.

## 10. Keyboard and screen reader

- Tab order: Back → drop zone input → name field → summary links → main buttons → Undo (when shown) → each group:
  heading toggle → group actions → rows' buttons. Hidden (closed) groups take no Tab stops.
- Toggle: Enter and Space open and close (native button). `aria-expanded`, `aria-controls` to the rows list.
- Each group's rows are a `<ul>` with `aria-labelledby` the heading.
- One polite live region (`sr-only`, `aria-live="polite"`), and only these announcements, so a 30-file run is not
  read out row by row:
  - start: "Reading 7 files."
  - end: the end-of-run line (5.4).
  - remove: the Undo sentence (the notice's `role="status"` already does this; do not announce twice).
  - Undo: "Put back 4 files."
- Remove the `aria-live` from the counts line (today it re-reads all counts on every step).
- Focus is never lost when a row moves to another group or is removed: see 6.2. When a file the person has focus on
  moves group during reading (rare: Waiting rows have no buttons while reading), move focus to its new group heading.
- Text contrast: every pair listed in 4.2 is at least 5.6:1; body and muted text use `--text` and `--text-muted`
  (6.3:1 light, 6.6:1 dark on `--surface`). Replace the undefined `var(--muted)` with `var(--text-muted)` and
  `var(--ok, ...)` with `var(--good)`.
- `prefers-reduced-motion`: the pulsing dot stays still (already done; keep it).

## 11. Tests for the builder

- Unit (`batchState.test.ts`): `summarize` per group; duplicates not counted as needing the person; `groupOf` for
  every state; `shortName` (short, exact, long with `(3).pdf` end, Hebrew name).
- e2e (`batch-screen-groups.spec.ts`, own database rules: unique names, clean up what you add): read one file, then
  drop three exact copies of it plus two new files; expect an "Already on file" group with 3, closed; open it; press
  Remove all 3; expect the Undo line naming the files; press Undo; expect 3 back; Remove all again. Check the summary
  never says "need you" for duplicates. A Hebrew-named file shows inside `<bdi>`.
- Browser screenshots at 1400, 768 and 390 px, light and dark, before `in-review`.

## 12. Out of scope (later)

- Telling "already on file" at drop time, before reading. Needs a backend check by file hash (request below).
- Sending a Needs-you file straight to New report with the file already attached (needs App-level wiring, overlaps the
  coming "drop on New report" work).
- Removing ready-to-check drafts from this screen.

## 13. Requests and questions

- backend-dev (later, not for SL-60): an endpoint that answers "which of these file hashes are already on file" so
  duplicates can be shown before any reading starts.
- Product question (owner): should the name field stay on this screen at all? See the report.
