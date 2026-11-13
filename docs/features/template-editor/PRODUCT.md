# Template editor: product brief

Status: Q1 to Q5 answered 2026-11-13; ready for planning. Written 2026-11-13. Owner: product-manager.

## 1. Problem and users

The user (Nir), translated from Hebrew: "Different report types, creating new
report types and so on: this still needs to be arranged so that it is
convenient, with a clear interface, probably WYSIWYG."

Users: core facility managers. A template says which fields a report of one kind
has, so the review screen can ask for them and the reading can fill them in.
A template that matches the printed form well is part of the 99% target (99% of
fields approved without edits). Today a facility manager who meets a new kind of
report has to understand the template form first. That is the wrong job for them.

### What exists today (checked in the code)

- **Templates tab** lists templates (report type, model, field count, report
  count). Actions: New, Edit, Duplicate, Compare, Delete (blocked while any
  report uses it), Field aliases.
- **Template form**: a list of fields (name, type, unit, notes, choices, table
  columns). It suggests up to 3 existing templates to start from (same report
  type and model family first).
- **Pick from a PDF** (`TemplatePdfPicker`): choose a stored sample PDF, click or
  drag over words or a box, and the field name, type and notes are guessed. The
  page and box are saved with the field. This is the WYSIWYG part that already
  exists, but it adds one field at a time into a form.
- **Field types**: text, number, date, yes/no, one choice, many choices, table
  (columns of text, number, date, yes/no), and two special number lists (per
  detector, per laser).
- **Resolution**: a report gets the template for instrument type + report type,
  and a model-specific one wins over the "any model" one.
- **Waiting report**: intake can open a prefilled new-template form for a report
  that has no template for its model.
- **Compare** two templates side by side, and **field aliases** (names that mean
  the same thing). Advice only.

### What is hard today

1. **Report types are fixed at three** (repair, preventive maintenance,
   installation or upgrade). A fourth needs a developer: a code change and a
   database migration. A "new report type" in the user's sense (for example a
   calibration certificate or a decontamination form) cannot be made on screen.
2. **No preview.** You build a form of fields, save, and only see the result when
   a real report is opened on the review screen.
3. **The PDF is a side tool, not the canvas.** Fields are not shown on the page,
   so you cannot see which parts of the form are still not covered.
4. **No versions.** Saving a template overwrites it. Reports already made keep
   their values, but a removed or renamed field stops being shown for them (the
   form warns, but does not prevent it). Nothing says "this report was made with
   the old version".
5. **No safe test.** There is no way to run a new or changed template over a
   sample PDF and see what the reading would fill in, before real reports use it.
6. **Variants are confusing.** "Report type" and "model" are two separate ideas
   (what kind of document, and which instrument it is for) but sit side by side
   in the form with no explanation.
7. **Anyone can edit and delete.** Sign-in and roles are planned, not built.

## 2. Goals and non-goals

Goals
- A facility manager can create a new report type, with its first template, from
  a sample PDF in a few minutes, without a developer.
- They build the template looking at the PDF page, with fields drawn on it, and
  see how the review screen will look as they go.
- They can try the template on a sample PDF before any real report uses it.
- Changing a template that finalized reports already use cannot silently change
  or hide what those reports show.
- A person on a draft "needs a report type" (from email intake) can pick or
  create the type right there.

Non-goals (do not build)
- Not a free-form page designer. The review screen layout stays the app's own.
- No drawing of the printed form's look; the PDF is only a guide.
- No automatic template creation by Claude, and no template audit ("suggest
  missing fields from real reports"). That stays a separate proposal.
- No import or export of templates between installations.
- No new field types. Existing ones only.
- No phone layout for the editor (desktop first; it must not break on a phone).
- No sign-in or roles work here (see rule R-7). No change to how the reading
  decides values.
- No translation of templates (English UI only).

## 3. User stories and acceptance criteria

### Story A. Create a new report type
As a facility manager, I can add a report type that is not in the list, so a new
kind of document gets its own template.

- AC-01 `must`: In the template editor I can add a new report type by typing a
  plain name (for example "Calibration"). It then appears in every report-type
  list in the app (template editor, report type picker, filters, analytics, classification, labels) without
  a code change or a deploy.
- AC-02 `must`: The three existing types keep working and keep their current
  names and reports. Existing reports and templates are unchanged after the
  feature is switched on.
- AC-03 `must`: A name that already exists (ignoring capital letters and extra
  spaces) is refused with a message that names the existing type.
- AC-04 `must`: A report type that no template and no report uses can be
  deleted, and the screen says exactly what will be deleted. One that is in use
  cannot be deleted; the screen says how many templates and reports use it.
- AC-05 `later`: Rename a report type; every template and report shows the new
  name.

### Story B. Build a template from a sample PDF
As a facility manager, I start from a sample report PDF and mark the fields on
the page.

- AC-06 `must`: "New template" offers a choice of starting points: from a
  sample PDF (a stored one, the waiting draft's own, or one uploaded now that is discarded when I finish unless I choose to keep it as the template's reference sample), from a copy of an existing
  template, or blank.
- AC-07 `must`: In the editor the PDF page is always visible next to the field
  list. Each field already marked is shown as a box on the page with its name.
  Clicking a box selects the field in the list, and clicking a field in the list
  shows its box.
- AC-08 `must`: I can add a field by clicking a word or dragging a box on the
  page. The name, type and notes are suggested and I can change them. This works
  for several fields in a row without leaving the page.
- AC-09 `must`: I can move or resize a field's box, change its type, rename it,
  reorder it, and remove it, without leaving the page.
- AC-10 `must`: Tables: I can mark a table region, name the columns (text,
  number, date, yes/no) and reorder them. The preview shows them as a table.
- AC-11 `must`: Fields with a fixed set of answers (one or many choices) can
  have their choices typed in. Number-per-detector and number-per-laser can be
  chosen where they exist today.
- AC-12 `must`: Page text that has no marked field is visible as such (for
  example lightly shaded), so I can see what I have not covered yet.
- AC-13 `must`: If the PDF has no text layer (a scan), I can still draw boxes
  and name fields by hand, and the screen says that no suggestions are possible
  for this file.
- AC-14 `later`: A suggested first draft of fields from the sample PDF, by
  Claude. Not in this build (R-14).

### Story C. See the result before saving
As a facility manager, I see how the review screen will look while I build.

- AC-15 `must`: A preview shows the fields as the review screen will show them
  (same labels, order, input types, tables, units), and updates as I edit.
- AC-16 `must`: The preview shows no real values. Nothing in the preview is
  stored.
- AC-17 `must`: The editor refuses to save a template with no fields, a field
  without a name, a duplicate field name, or a choice field without choices, and
  says which field and what to fix.

### Story D. Try it on a sample before use
As a facility manager, I check a template on a real sample before real reports
use it.

- AC-18 `must`: From the editor I can "Try on a sample": the reading runs on a
  chosen sample PDF with this (unsaved) template, and the result opens in the
  preview with each value and its confidence.
- AC-19 `must`: A trial creates no report and nothing in the instrument's
  history. It is not visible to any other user and not counted in lists.
- AC-20 `must`: In the demo, with live Claude calls off, the trial uses the
  stub reading and says so on screen. A live trial is not run unless the live
  setting is on.
- AC-21 `must`: After a trial I can see which fields came back empty or with low
  confidence, so I know what to fix in the template.
- AC-22 `later`: Save the sample and its expected values with the template, and
  re-run it whenever the template changes.

### Story E. Change a template that reports already use
As a facility manager, I can improve a template without damaging finalized
reports.

- AC-23 `must`: Before I save a change to a template that reports use, the
  screen says how many reports and how many finalized reports use it, and lists
  what the change does: fields added, fields removed, fields renamed, type
  changed.
- AC-24 `must`: A finalized report keeps showing exactly the fields and values
  it had when it was finalized, whatever I change afterwards.
- AC-25 `must`: Draft reports that are still open get the new version the next
  time they are opened, and values of a removed field are kept (not lost) until
  the report is finalized or the person removes them.
- AC-26 `must`: Each saved change of an in-use template is a new numbered
  version. Every template that exists before this feature becomes version 1, with its reports unchanged. I can see the version list with date and a one-line summary of the
  change, and open an older version read-only.
- AC-27 `later`: Restore an older version as a new version.
- AC-28 `must`: A report shows which version of the template it was made with
  (in its details, not in the main view).

### Story F. Picking a variant: type, then model
As a facility manager, I understand when I am making a new type and when I am
making a version for a specific model.

- AC-29 `must`: The first question in "New template" is plain: "What kind of
  report is this?" with the list of types and "A new kind of report".
- AC-30 `must`: The second question is "Which instruments is it for?" with "Every
  model" (default) or one model name chosen from the models already known.
- AC-31 `must`: If a template for this type and model already exists, the screen
  says so and offers to open it, or to start a copy of it for another model.
- AC-32 `must`: The editor shows, in one sentence, which reports will use this
  template (for example "Repair reports for the FACSAria III; other models use
  the Every model template").

### Story G. Create the type while a draft waits
Email intake (`docs/features/email-intake/PRODUCT.md`, branch `spec-email-intake`, AC-10 outcome 2) creates drafts marked "needs a report type". Creating a type and template from such a draft must be quick; AC-33 to AC-36 are written for that case.

As a facility manager with a draft that "needs a report type" (from email
intake), I can pick or create the type right there.

- AC-33 `must`: On such a draft I can choose an existing type, or "A new kind of
  report", which opens the editor in the same window with the draft's sample
  PDF already on the page.
- AC-34 `must`: After I save, I land back on the same draft, now with the new
  type and template applied and the reading started. Nothing else is lost.
- AC-35 `must`: If I cancel, the draft is unchanged and still waiting.
- AC-36 `must`: Naming a new type from the draft takes no more than: type a
  name, check the suggested fields, save. No other screen is required first.

### Story H. Privacy and safety in the editor
- AC-37 `must`: A sample PDF and its text are shown only to the person editing, and an upload is discarded when editing ends unless I chose to keep it as the reference sample.
  The saved template keeps field names, types, notes, choices and box positions,
  but never the sample's text, file name or any value read from it.
- AC-38 `must`: When a field name or note suggested from the sample looks like a
  person's name, e-mail address or phone number, the editor does not use it as
  a suggestion and says why.
- AC-39 `must`: Every delete (template, type, field with data) says exactly what
  it deletes.
- AC-40 `must`: Wording is plain English, short sentences, each message says what
  to do next. The editor works with the keyboard alone (every action reachable,
  boxes selectable with Tab and moved with the arrow keys).

## 4. Product rules

| # | Rule | Status |
|---|------|--------|
| R-1 | Report types become data, not a fixed list of three. The three current types stay, with their current names. New types appear everywhere types are used: filters, analytics, templates and classification. | `decided` 2026-11-13 (Q1 = A) |
| R-2 | A template is for one instrument type, one report type and either one model or every model. A model-specific template wins over "every model". This is today's rule and stays. | `decided` (existing behaviour, `PLAN.md` / template resolution) |
| R-3 | Finalized reports never change because a template changed. User: "every change in the report structure must not harm reports already uploaded." Numbered versions; every existing template becomes version 1. | `decided` 2026-11-13 (Q2 = A) |
| R-4 | Open drafts move to the newest version when next opened; removed-field values are kept. | `decided` 2026-11-13 (Q2 = A; the kept-values detail is `assumed`) |
| R-5 | Desktop first. The editor must not break on a phone but no phone design is built. | `decided` (lead's context: desktop first) |
| R-6 | English only. | `decided` (CLAUDE.md) |
| R-7 | Who may edit templates: anyone past the shared password. When sign-in with editor and read-only roles arrives, only editors; admin-only creation of report types comes then too. This feature adds no roles and adds one clear place to check (one "may edit templates" rule). | `decided` 2026-11-13 (Q1: admin-only creation comes with roles later); Q4 `assumed` A |
| R-8 | Trials use the stub reading unless live Claude is on. A live trial counts toward the daily Claude limit (60 per day). | `decided` (CLAUDE.md user decisions, cost rule) |
| R-9 | Templates, types and versions are shared across the installation and may be seen by other institutes only as field names and structure, never as sample content. | `assumed`; confirm with Q3 |
| R-10 | Samples come from stored reports, from the waiting draft's own PDF, or are uploaded only while editing. An upload is discarded unless kept on purpose as the template's reference sample. | `decided` 2026-11-13 (Q3 = A) |
| R-11 | Template audit (suggest fields from real reports), import/export, restoring versions, and saved test samples are not in this build. | `decided` as non-goals in this brief; the user can reverse |
| R-14 | No Claude field suggestions in this build; suggestions are word-based only. | `assumed` 2026-11-13 (Q5 = A) |
| R-12 | The editor reuses existing field types and the existing "Compare" and "Field aliases" tools; neither is changed. | `assumed` |
| R-13 | Stop at demo-ready: when every `must` criterion is met, the team stops and reports. `later` items are listed, not built. | `decided` (CLAUDE.md) |

## 5. Questions and answers (2026-11-13)

Answered: Q1 = A (real, user-made types; admin-only creation with roles later).
Q2 = A (numbered versions). Q3 = A (samples as in R-10). Q4 = A, `assumed`.
Q5 = A, `assumed`. Q6 `assumed`. No open questions remain. The original options
are kept below for the record.

### Original questions

**Q1. Is a new report type a real type, or just a name on a template?**
Today the type is a fixed list of three, used for filters, labels and the
choice of template. Options:
- A. Real, user-made types (a list kept in the app; any facility manager can add
  one). Filters and pickers include them. More work now; matches "creating new
  report types" in the request.
- B. Keep three fixed types plus a free "Other: <name>" label on the template.
  Cheap, but filters and history group everything new under "Other".
- C. Real types, but only an administrator can add them (needs roles).
Recommendation: A, with the three existing ones kept as they are. Blocks:
AC-01 to AC-05, AC-29, AC-33 to AC-36, and the whole data design.

**Q2. When a template changes, what happens to existing reports?**
Options:
- A. Versions. Each save of an in-use template makes a new version; finalized
  reports stay on the version they were finalized with; open drafts move to the
  newest. (Recommended: finalized reports are shared with other institutes, and
  their fields must not shift.)
- B. No versions. Block removing or renaming fields on an in-use template; only
  adding fields is allowed. Simpler, but a mistaken field can never be fixed
  without a copy.
- C. Today's behaviour (overwrite, warn). Not recommended: finalized reports lose
  displayed fields.
Recommendation: A. Blocks: AC-23 to AC-28, the data model, and the migration of
existing templates (each becomes version 1). Expensive to change later.

**Q3. Where do sample PDFs come from, and how long are they kept?**
Today the picker only offers PDFs already attached to stored reports. Options:
- A. Stored PDFs plus an upload used only while editing, then discarded unless
  I choose to keep it. (Recommended.)
- B. Stored PDFs only (no upload). The first template for a brand-new type could
  not be built until a report of that kind exists, which defeats the email-intake
  case unless the draft's own PDF is used.
- C. Uploads kept permanently as the template's "reference sample".
Recommendation: A, plus the draft's own PDF when starting from a waiting draft.
Blocks: AC-06, AC-33, AC-37, privacy review. Keeping documents is the
expensive-to-change part, so please confirm.

**Q4. Who may edit templates before sign-in exists?**
Options:
- A. Anyone using the app, as today, and tighten when roles arrive. (Recommended
  for the demo, with one clear "may edit" rule so adding roles later is small.)
- B. Hide the editor behind a simple shared setting until roles exist.
Recommendation: A. Blocks: R-7 only. Low cost to change.

**Q5. Should Claude suggest a first set of fields from the sample PDF?**
Options:
- A. Not in this build; the person marks fields (suggestions are word-based only,
  as in the picker now). (Recommended: no cost, no privacy risk, demo works
  offline.)
- B. Yes: one Claude call per sample draws a first draft. Faster for long forms,
  but costs money, needs the privacy scrub, and is close to the "template audit"
  proposal.
Recommendation: A for now, B as `later` (AC-14). Blocks: AC-14 only.

**Q6 (cheap, `assumed` unless the user objects).** Trial "Try on a sample" is
one sample at a time, in the demo uses the stub reading, and shows
confidence per field. Template versions show a one-line summary written by the
system, not typed by the person.

## 6. Demo-ready definition for this feature

Every `must` criterion above is met, with live Claude off, in the browser on
desktop: create a new report type from a sample PDF, try it on a sample, save,
use it on a waiting draft, change it after a report is finalized and see that the
finalized report did not change.

## Changes

- 2026-11-13: Nir answered Q1 to Q5. R-1, R-3, R-4, R-7, R-10 now `decided`; new R-14 (`assumed`). Edited AC-01 (analytics and classification named), AC-06 and AC-37 (upload discarded unless kept), AC-14 (not built), AC-26 (existing templates become version 1). Added the email-intake link under Story G. No build had started, so no tasks are affected beyond the planner's inputs.
