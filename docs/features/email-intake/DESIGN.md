# Email intake: design brief

Owner: ux-reviewer (SL-63). Date: 2026-11-13.
Inputs: `PRODUCT.md` (AC-01 to AC-33), `API.md`, `PLAN.md` (SL-76, SL-81, SL-84, SL-85), the design system rules (`docs/design-system/README.md` and `tokens.json`, branch SL-58), `frontend/src/index.css` and `frontend/src/styles/`, the Admin screen (`AdminScreen.tsx`) and the "Reading accuracy" and "Glossary" sections of PR #305.
Conflict rule: `PRODUCT.md` wins over this brief, and this brief wins over `PLAN.md`. Where this brief goes further than the plan, the plan's own wording is kept word for word inside the longer text, so tests written to the plan still pass.

This brief was written from the code and the documents. I did not run the app for it.

## 0. Summary

| What | Where | Task |
|---|---|---|
| Allowed senders (addresses and whole domains, each with a team or role) | Admin > Email intake > Allowed senders, `#/admin/email` | SL-76 |
| Files held for a check ("Check: maybe not a service report") | Admin > Email intake > Held for a check, `#/admin/email/held` | SL-84 |
| Email log and the intake status line | Admin > Email intake > Email log, `#/admin/email/log`; the status line sits above all three | SL-84 |
| Source line ("Received by email" or "Uploaded in the app") | Report page (drafts and read reports) and the top of the Continue flow | SL-81 |
| "By email" marker | Reports list rows, phone cards and the "Not read yet" group | SL-81 |
| Read states: "Needs a report type", "Waiting for the daily limit", "Being read", "Not read yet" | Report page of a draft that is not read yet | SL-81 (banners), SL-85 (Continue) |
| Continue an unread draft | Report page "Continue" button, then the New report flow at the right step | SL-85 |

No new design tokens. One new CSS file, `frontend/src/styles/NN-email-intake.css` (the next free number at build time), imported last from `App.css`.

## 1. Where it lives

### 1.1 Admin navigation

- One new item in the Admin side menu (`admin-nav`, `admin-nav-item`): **Email intake**. Place it after "Field aliases" and before "Appearance" (Appearance is a personal setting and stays last). With PR #305 merged the order is: Data export, Reading accuracy, Glossary, Field aliases, Email intake, Appearance.
- When files are held, the item shows a count: `Email intake` followed by a small count badge (`ei-count`, see 3.3), for example "Email intake 2". The badge has `aria-hidden="true"` and the button gets an `sr-only` text " (2 files to check)". No badge when the count is 0 or the held list could not be loaded.
- Admin is reached from the Admin tab on wide screens, from the top bar More menu when the tabs do not fit (SL-56), and from More > Admin on a phone. Nothing new is added to the top bar or the bottom tab bar.

### 1.2 Inside Email intake

Under the section heading, a row of three links that switch the part shown (`ei-subnav`, a `<nav aria-label="Email intake">` of `btn small` buttons; the current one has `aria-current="page"` and the `active` look of `view-switch .btn.active`):

| Label | Route | Shows |
|---|---|---|
| Allowed senders | `#/admin/email` | 4 |
| Held for a check (2) | `#/admin/email/held` | 5. The number is shown only when it is above 0 |
| Email log | `#/admin/email/log` | 6 |

- These are links between pages (they change the address, the Back button works, each can be bookmarked), not tabs. Do not use `role="tab"`.
- `AdminScreen` today matches the section by exact name (`SECTIONS.find(s => s === section)`). It must treat `email`, `email/held` and `email/log` as the Email intake section. An unknown `email/...` route shows Allowed senders.
- Page title (`h1.admin-title`, the same as the other Admin sections): **Email intake**. Each part has its own `h2`: "Allowed senders", "Check: maybe not a service report", "Email log".

### 1.3 Status line (all three parts)

Directly under the `h1`, from `GET /email-intake/status`. A short paragraph (`ei-status`) with a state pill first.

| State | Pill | Text |
|---|---|---|
| `enabled`, `intake_address` set | **On** (`ei-state-on`) | "Reports sent to **intake@example.org** are loaded as drafts. Up to 10 PDFs per email, each up to 20 MB. The mailbox is checked every minute." |
| `enabled`, no `intake_address` | **On** | "Reports sent to the intake address are loaded as drafts. Up to 10 PDFs per email, each up to 20 MB. The mailbox is checked every minute." |
| `enabled`, `mailbox = "folder"` | **On** | Add a second sentence: "This is the test mailbox: emails are read from a folder on the server, and replies are saved there instead of being sent." |
| not `enabled` | **Off** (`ei-state-off`) | "Email intake is off. Nothing is read from the mailbox. Ask whoever runs the server to switch it on. You can still prepare the list of allowed senders." |
| loading | none | Nothing is shown (no spinner; the line appears when it arrives) |
| request failed | none | Nothing is shown. This line is information only; the rest of the page still works |

- The numbers come from the response (`max_pdfs_per_message`, `max_pdf_megabytes`, `poll_interval_seconds`). Interval wording: 60 gives "every minute"; under 60 gives "every N seconds"; above 60 gives "every N minutes" (rounded).
- The intake address is in `font-family: var(--font-mono)` and can be selected and copied. Add a `btn small` **Copy address** after it; on success, toast "Address copied". If the browser blocks copying, toast "Could not copy. Select the address and copy it yourself."
- The intake address is the app's own address, not a person's. It may be shown.

## 2. User flows

### 2.1 Admin sets up who may send (AC-20, AC-21)

1. Admin > Email intake. Allowed senders is shown.
2. "Add a sender". Choose "One address" or "A whole domain", type it, type the team or role, "Add sender".
3. Toast "Sender added". The new row is in the list.
4. Later: "Change team or role" in a row, or "Remove" in a row, then "Confirm remove".

Failure paths: a typo or a person's name in the label is caught in the form (4.3); the address is already listed (409, the API's sentence); the network fails (form keeps what was typed, banner says try again); a public mail domain such as gmail.com is typed as a whole domain (warning, 4.4).

### 2.2 A sender emails a report; someone checks it (AC-01, AC-03, AC-10, AC-28)

1. The sender emails PDFs to the intake address and gets one reply (not designed here; SL-77 owns the reply text).
2. In the app, the report appears on Reports with the "By email" marker (7). A recognised form is read on its own and lands as "Needs review" like a web upload.
3. The person opens it. The report page shows the source line: "Received by email · Flow core team · 13 Nov 2026, 09:14" and "Sent from lab-team@example.org" (8).
4. They check the fields and finalize, exactly as today. Nothing about approval changes.

Branches:
- **Needs a report type** (outcome 2): the report stays in "Not read yet". Its page says so and offers **Continue** (9.2). Continue opens the Classify step, where they pick the instrument and report type, or make a new form from this report with the existing template suggestion. Then it is read and reviewed as usual (10).
- **Not read on its own** (the reading was unsure, the report is in Hebrew, or reading failed): same as above, with the "Not read yet" text (9.2), Continue lands on the step that needs a person.
- **Waiting for the daily limit**: the page says it will be read after the limit resets. Nothing to do (9.2).
- **Held** (outcome 4): nothing appears on Reports. It is in Admin > Email intake > Held for a check (2.3).
- **Refused, unknown sender, duplicate**: nothing appears on Reports. One line in the Email log (2.4).

### 2.3 Admin checks a held file (AC-26)

1. Admin > Email intake shows "Email intake 1" in the side menu. Open "Held for a check (1)".
2. Each row: when it arrived, the team or role, why it was held, pages and size. "Open PDF" opens it in a new tab.
3. If it is a service report: **Load as draft**. A success banner says it is now a draft, with a link "Open the draft". The row leaves the list.
4. If it is not: **Delete**, then "Confirm delete". Toast "PDF deleted". The row leaves the list.

Failure paths: someone else already loaded or deleted it (409 or 404: own sentence, the list reloads); network failure (banner, row stays, try again); the PDF file is missing on the server ("Open PDF" gives a 404 page in the new tab; acceptable, see Open questions).

### 2.4 Admin finds out why an email did nothing (AC-11, AC-12)

1. Admin > Email intake > Email log.
2. Newest first: time, who sent it (the team and the address for allowed senders; "Not on the list" for others), what happened, the files, the reply.
3. "Older" and "Newer" page through 50 at a time. "Refresh" reloads the first page.

## 3. Shared rules for these screens

### 3.1 Reuse

| Need | Use |
|---|---|
| Section layout | `admin-screen`, `admin-nav`, `admin-nav-item`, `admin-title`, `admin-lead` |
| Forms | `admin-form` (label above field), `btn`, `btn primary`, `btn small`, `hint-text` |
| Tables | `trend-table` inside a `trend-table-wrap` with `tabIndex={0} role="region" aria-label="..."` (axe rule from CLAUDE.md); left-aligned text columns as in the Glossary (`ei-table`, 3.3) |
| Messages | `Notice` / `banner banner-info`, `banner banner-warn`, `banner banner-crit` |
| Confirm before delete or remove | The inline `banner banner-crit` with `role="alertdialog"` used by Places, Models and the report page, with `btn small danger solid` "Confirm ..." and `btn small` "Cancel". Not `window.confirm` |
| Loading | `working-panel` with `spinner` and a text |
| Short success messages | the existing toast (`showToast`) |
| Pills | `status-pill` shape (12px, weight 600, pill radius) |
| Hidden text for screen readers | `sr-only` |
| Links that look like text | `link-button` |

### 3.2 Dates and sizes

- Received time on Admin screens and the source line: the browser's locale, day, short month, year, hours and minutes, for example "13 Nov 2026, 09:14": `toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })`. Put it in `<time dateTime={iso}>`. Local time, as everywhere else in the app.
- On the Reports list the date stays in the list's own ISO style ("received 2026-11-13"), to match "uploaded 2026-11-13" next to it.
- Sizes: under 1 MB in KB with no decimals ("179 KB"); from 1 MB with one decimal ("4.2 MB"). Pages: "1 page", "2 pages".

### 3.3 New CSS (file `NN-email-intake.css`, existing variables only)

| Class | What it does |
|---|---|
| `ei-section` | Column of the part, `display: flex; flex-direction: column; gap: var(--space-4); min-width: 0`. No `max-width` (the tables need the room; `admin-card` stays 560px for the forms) |
| `ei-subnav` | `display: flex; flex-wrap: wrap; gap: var(--space-2)`. Current link: `background: var(--accent-fill); border-color: var(--accent-fill); color: var(--on-fill)` (the `view-switch .btn.active` look) |
| `ei-status` | `color: var(--text-muted)`, `font-size: var(--text-sm)`, `max-width: 72ch`, `margin: 0` |
| `ei-state-on` | `status-pill` shape, `background: var(--good-soft); color: var(--good)` (green means healthy, allowed by the design system) |
| `ei-state-off` | `status-pill` shape, `background: var(--surface-2); color: var(--text-muted)` |
| `ei-count` | Badge in the side menu and nothing else: `status-pill` shape, `background: var(--flag-soft); color: var(--text); border: 1px solid var(--flag)` (amber means "needs a second look") |
| `ei-table` | On `trend-table`: text cells left-aligned in `var(--font-ui)`, `white-space: normal`, `vertical-align: top`; number cells keep mono and right alignment (class `num`); addresses and domains `overflow-wrap: anywhere` |
| `ei-sub` | Second line in a cell: `display: block; color: var(--text-muted); font-size: var(--text-sm)` |
| `ei-addr` | Address or domain: `font-family: var(--font-mono); overflow-wrap: anywhere` |
| `ei-actions` | Row buttons: `display: flex; flex-wrap: wrap; gap: var(--space-2); justify-content: flex-end` |
| `ei-field-error` | Error under a field: `color: var(--crit); font-size: var(--text-sm)`, text always starts with the problem in words (never colour alone) |
| `source-line` | The source line (8): `font-size: 0.82rem; color: var(--text-muted)`, same as `report-heading-meta`; long text wraps |
| `source-pill` | "By email" marker (7): `status-pill` shape, `background: var(--surface-2); color: var(--text-muted)`, `text-transform: none` |
| `unread-panel` | Report page of an unread draft (9): `display: flex; flex-direction: column; gap: var(--space-3)` |
| Phone rules | See 12 |

- The base input rule (`01-shell-forms-intake.css`) does not include `input[type='email']`. The address field uses `type="email"` (right phone keyboard), so this file adds `input[type='email']` to the same look: font, padding, radius, `--input-border`, `--surface`, `--text`, `width: 100%`, and the focus outline.
- Keep the braces balanced after the merge into `App.css` (CLAUDE.md).

### 3.4 Contrast (existing pairs, checked with the WCAG formula)

| Text on background | Light | Dark | Where |
|---|---|---|---|
| `text-muted` on `surface-2` | 5.6:1 | 5.7:1 | "By email" marker, "Off" pill |
| `text-muted` on `surface` / `bg` | 5.8:1 | 7.6:1 | status line, second lines, source line |
| `text-faint` on `surface` | 5.2:1 | 5.5:1 | table header labels (existing `trend-table th`) |
| `good` on `good-soft` | existing pair | existing pair | "On" pill (already used for "Finalized") |
| `text` on `flag-soft` | 14.8:1 | 11.3:1 | count badge, warning banners |
| `crit` on `surface` | 6.5:1 | 4.9:1 | field errors, "Not sent" in the log |
| `accent-strong` on `accent-soft` | 8.1:1 | 7.5:1 | info banners |
| `accent` on `surface` | 7.0:1 | 6.8:1 | links |

All pass 4.5:1. The light `--input-border` gap (1.9:1, SL-57) applies here as everywhere; do not work around it in this file.

### 3.5 Who may change things

- Today Admin is open to everyone past the shared password (PLAN Open question A). Every control in this brief is shown.
- After SL-42 (editor and read-only roles): a read-only person sees the lists without Add, Change, Remove, Load as draft and Delete, and one `hint-text` under the `h2`: "You can look at this list. Only editors can change it." If the GET routes become editor-only (CCR-E01) and a read-only person opens the section, show `banner banner-info`: "Only editors can see email intake." and nothing else.

## 4. Allowed senders (`#/admin/email`, SL-76)

### 4.1 Layout, top to bottom

1. `h2` "Allowed senders".
2. `admin-lead`: "Email from these addresses and domains is loaded as draft reports. Email from anyone else is dropped without a reply. A person still checks every report before it is finalized."
3. `btn primary` **Add a sender** (aligned left, like "Add a term" in the Glossary). When the form is open, the button is replaced by the form (4.2).
4. The confirm banner, when a remove is pending (4.5).
5. The table (4.4), or the empty or loading state.

### 4.2 The add form (`admin-form`, inside a `<form>`, max width 520px)

| Order | Control | Label | Details |
|---|---|---|---|
| 1 | Two radio buttons in a `<fieldset>` | Legend "What to add". Options "One address" (default) and "A whole domain" | Each option is a `<label>` with the radio inside, at least 44px tall on a phone |
| 2 | Text field, when "One address" | "Email address" | `type="email"`, `autoComplete="off"`, `autoCapitalize="none"`, `spellCheck={false}`, `inputMode="email"`, placeholder "lab-team@example.org" |
| 2 | Text field, when "A whole domain" | "Domain" | `type="text"`, `inputMode="url"`, `autoCapitalize="none"`, `spellCheck={false}`, placeholder "example.org". `hint-text` under it: "Everyone whose address ends in @example.org may send. Addresses at sub-domains (such as @lab.example.org) are not included. If one address of this domain is also listed on its own, its own team or role is used." (Show the domain the person typed in place of example.org once there is one.) |
| 3 | Text field | "Team or role" | `type="text"`, `maxLength={60}`, placeholder "Flow core team". `hint-text` under it: "A team or role, such as Flow core team or Imaging core. Not a person's name. It is shown on every report this sender sends." |
| 4 | `btn primary` | "Add sender" | Becomes "Adding…" and disabled while saving |
| 5 | `btn` | "Cancel" | Closes the form, keeps nothing, focus returns to "Add a sender" |

- Switching between "One address" and "A whole domain" keeps what was typed in the field and clears any error under it.
- A leading "@" in the domain field is removed silently on save ("@example.org" becomes "example.org").
- The value is trimmed and shown lower-case in the list (the API stores it so).
- Focus: when the form opens, focus goes to the first radio.

### 4.3 Validation messages

Checked on "Add sender", in this order, in `allowedSenderRules.ts` (the same rules as API.md section 1). Each message sits under its field in `ei-field-error` with an `id`; the field gets `aria-invalid="true"` and `aria-describedby` pointing to it; focus moves to the first field with an error. Messages clear when the field changes.

| Problem | Message |
|---|---|
| Address empty | "Type the email address." |
| Address not valid (not exactly one @, empty part before @, no dot after @, spaces) | "This does not look like an email address. Check it has one @ and a domain, for example lab-team@example.org." |
| Address over 254 characters | "This address is too long. Check it is one address." |
| Domain empty | "Type the domain, for example example.org." |
| Domain contains "@" after the first character | "Type only the part after the @, for example example.org. To add one address, choose One address." |
| Domain not valid (characters other than letters, digits, hyphens and dots; no dot) | "This does not look like a domain. Use letters, numbers, dots and hyphens, for example example.org." |
| Domain over 253 characters | "This domain is too long." |
| Team or role empty | "Type a team or role, for example Flow core team." |
| Team or role over 60 characters | "Keep the team or role to 60 characters or fewer." |
| Team or role contains "@" | "A team or role cannot contain @. Use a name such as Flow core team, not an address." |
| API 409 | The API's own sentence under the address or domain field ("This address is already on the list." / "This domain is already on the list.") |
| API 422 | The API's own sentence (`detail`) in a `banner banner-crit` with `role="alert"` above the buttons |
| Network or other error | Same banner: "Could not add the sender. Check your connection and try again." The form keeps what was typed |

### 4.4 Public mail domains (a warning, not a block)

If "A whole domain" is chosen and the domain is a public mail service, show a `banner banner-warn` above the buttons when "Add sender" is pressed, and do not save yet:

"Anyone with an @gmail.com address could then send reports to ServiceLedger. Add single addresses instead, unless that is what you want."

Buttons in the banner: `btn small` **Add the whole domain anyway** (saves) and `btn small` **Change it** (closes the banner, focus to the Domain field).

List kept in `allowedSenderRules.ts`, with a comment that it is a convenience, not a security check: gmail.com, googlemail.com, outlook.com, hotmail.com, live.com, msn.com, yahoo.com, icloud.com, me.com, aol.com, proton.me, protonmail.com, gmx.com, gmx.net, mail.com, walla.co.il, walla.com. (Product rule: see Open questions; recorded as assumed.)

### 4.5 The table

`trend-table ei-table` in a `trend-table-wrap` with `tabIndex={0} role="region" aria-label="Allowed senders"`. A `<caption className="sr-only">Allowed senders: addresses first, then domains</caption>`. Order as the API returns it (addresses first, then domains, each A to Z).

| Column header | Cell |
|---|---|
| "Address or domain" | The value in `ei-addr`. For a domain, write "@example.org" in `ei-addr` and the `ei-sub` line "Whole domain". For an address, `ei-sub` "One address" |
| "Team or role" | The label (wraps) |
| "Added" | Date only, "13 Nov 2026" |
| (`sr-only` "Actions") | `ei-actions`: `btn small` **Change team or role**, `btn small danger` **Remove**. Each has an `aria-label` with the value, for example "Change team or role for lab-team@example.org", "Remove lab-team@example.org" |

**Change team or role** replaces the row with one cell (`colSpan` all) holding a small form: field "Team or role" (prefilled, same rules and messages as 4.3), `hint-text` "Reports already loaded keep the team or role they had.", `btn primary small` **Save** ("Saving…" while busy), `btn small` **Cancel**. Focus goes to the field, with the text selected. Success: toast "Team or role changed", focus returns to the row's "Change team or role" button. Errors as in 4.3 (404: banner "This sender was removed by someone else. The list is now up to date." and the list reloads).

**Remove** shows the confirm banner above the table (`banner banner-crit`, `role="alertdialog"`, `aria-label="Confirm remove sender"`):
- Address: "Remove **lab-team@example.org** (Flow core team) from the allowed senders? New mail from this address will be dropped. Reports already loaded stay. No reply is sent to dropped mail."
- Domain: "Remove the whole domain **@example.org** (Imaging core) from the allowed senders? New mail from this domain will be dropped, except from addresses listed on their own. Reports already loaded stay. No reply is sent to dropped mail."
- Buttons: `btn small danger solid` **Confirm remove** ("Removing…" while busy) and `btn small` **Cancel**. Focus goes to **Cancel** when the banner opens (Enter on a stray key press then does no harm); Escape cancels. After a remove, toast "Sender removed" and focus moves to the `h2` (with `tabIndex={-1}`). After Cancel, focus returns to the row's Remove button.
- A remove that fails: banner closes, `banner banner-crit` "Could not remove the sender. Check your connection and try again." A 404 counts as done: toast "Sender removed" and reload.

Only one form or confirm banner is open at a time: opening one closes the others.

### 4.6 States

| State | What is shown |
|---|---|
| Loading | `working-panel`: spinner and "Loading allowed senders…" in place of the table. "Add a sender" is disabled |
| Empty | `hint-text`: "No allowed senders yet. Until you add one, every email is dropped without a reply." "Add a sender" stays |
| Error loading | `banner banner-crit` with `role="alert"`: "Could not load the allowed senders. Check your connection and try again." with `btn small` **Try again** inside it. "Add a sender" is hidden |
| Saving (add, change, remove) | The pressed button shows its busy text; every button of that form or banner is disabled |
| Success | Toast ("Sender added", "Team or role changed", "Sender removed"); the list reloads |
| Read-only person (after SL-42) | See 3.5 |
| Long content | A 254-character address wraps inside its cell; a 60-character label wraps; the table never scrolls sideways on a phone (12) |

## 5. Check: maybe not a service report (`#/admin/email/held`, SL-84)

### 5.1 Layout

1. `h2` "Check: maybe not a service report".
2. `admin-lead`: "These PDFs came from allowed senders, but the app could not tell whether they are service reports. They are not read and do not count toward the daily limit. Open each one, then load it as a draft or delete it."
3. The result banner of the last action (5.3), when there is one.
4. The confirm banner, when a delete is pending (5.4).
5. The table, or the empty or loading state.

### 5.2 The table

`trend-table ei-table` in a `trend-table-wrap` with `tabIndex={0} role="region" aria-label="Held files"`, `<caption className="sr-only">Held files, oldest first</caption>`. Oldest first, as the API returns them (the one waiting longest is on top).

| Column header | Cell |
|---|---|
| "Received" | "13 Nov 2026, 09:14" |
| "From" | The team or role (`sender_label`). Never the address here (AC-26 asks for the label) |
| "Why it is held" | The API's `reason` sentence, as it comes |
| "File" | "2 pages · 179 KB" |
| (`sr-only` "Actions") | `ei-actions`: `a.btn small` **Open PDF** (`href` = the file URL with `?inline=1`, `target="_blank"`, `rel="noopener noreferrer"`, `sr-only` " (opens in a new tab)"); `btn small primary` **Load as draft**; `btn small danger` **Delete** |

Each row's buttons have an `aria-label` that tells rows apart, for example "Load the file received 13 Nov 2026, 09:14 as a draft", "Delete the file received 13 Nov 2026, 09:14".

There is no file name: it is never stored (AC-24). Do not invent one beyond the download name the API gives.

### 5.3 Load as draft

- On press: the button reads "Loading as draft…"; all three buttons of that row are disabled; other rows stay usable.
- Success: the row leaves the list. A `banner banner-info` appears at the top of the part, with `role="status"`, and focus moves to it (`tabIndex={-1}`). Text by `read_state`:
  - `queued`: "Loaded as a draft. It is being read now and will be on Reports in a minute." Link-button **Open the draft** (goes to `#/reports/<report_id>`).
  - `waiting_for_limit`: "Loaded as a draft. The app has reached its daily reading limit, so this one will be read after the limit resets. Nothing else to do." Link **Open the draft**.
  - `needs_person` (or anything else): "Loaded as a draft. It needs you to finish it: open the draft and choose Continue." Link **Open the draft**.
  - The banner has a `btn small` **Close**. It goes away on its own when another action starts.
- The side-menu count and the "Held for a check (n)" number go down by one.
- 404 or 409: `banner banner-warn` "Someone else already loaded or deleted this file. The list is now up to date." and the list reloads. (Do not show the API's "released" wording; the screen never says "release".)
- Other errors: `banner banner-crit` "Could not load this file as a draft. Check your connection and try again." The row stays.

### 5.4 Delete

- **Delete** opens the confirm banner above the table (`banner banner-crit`, `role="alertdialog"`, `aria-label="Confirm delete held file"`):
  "Delete the file received 13 Nov 2026, 09:14 from Flow core team? Deletes this PDF from ServiceLedger. Nothing else is changed: no report is made, the sender is not told, and the email log keeps a line saying it was deleted. This cannot be undone."
- Buttons: `btn small danger solid` **Confirm delete** ("Deleting…" while busy) and `btn small` **Cancel**. Focus to **Cancel** on open; Escape cancels; after Cancel focus returns to the row's Delete button.
- Success: toast "PDF deleted", the row leaves, counts go down, focus to the `h2`.
- 404 or 409: as in 5.3. Other errors: `banner banner-crit` "Could not delete this file. Check your connection and try again."

### 5.5 States

| State | What is shown |
|---|---|
| Loading | `working-panel`: "Loading held files…" |
| Empty | `hint-text`: "Nothing to check. When an allowed sender emails a PDF that might not be a service report, it waits here for you." |
| Empty, intake off | Same text; the status line above already says intake is off |
| Error loading | `banner banner-crit`, `role="alert"`: "Could not load the held files. Check your connection and try again." with **Try again** |
| Busy | Per row, 5.3 and 5.4 |
| Many rows | No paging (the list is expected to stay short); the table grows. Above 50 rows is unusual; see Open questions |

## 6. Email log (`#/admin/email/log`, SL-84)

### 6.1 Layout

1. `h2` "Email log".
2. `admin-lead`: "Every email the app received in the last 90 days, newest first. The app never keeps the subject, the text of the email or the file names. Addresses are kept only for allowed senders."
3. A row with the count and the paging buttons: "Showing 1–50 of 132" then `btn small` **Newer** and **Older** and `btn small` **Refresh**. "Newer" is disabled on the first page and "Older" on the last.
4. The table, or the empty or loading state.

### 6.2 The table

`trend-table ei-table` in a `trend-table-wrap` with `tabIndex={0} role="region" aria-label="Email log"`, `<caption className="sr-only">Email log, newest first</caption>`.

| Column header | Cell |
|---|---|
| "Received" | "13 Nov 2026, 09:14" |
| "From" | Allowed sender: the label, then the address in `ei-sub ei-addr`. Others: "Not on the list" in `ei-sub` style (no address exists to show, AC-12). `sender_not_verified`: "Sender could not be confirmed" |
| "What happened" | The outcome words from 6.3, then the API's `reason` in `ei-sub` when there is one |
| "Files" | From the counts (6.4) |
| "Reply" | `none`: "None"; `pending`: "Waiting to send"; `sent`: "Sent"; `failed`: "Not sent" in `--crit` with `ei-sub` "Tried 3 times" |

### 6.3 Outcome words (`emailLog.ts`, with a Vitest test per value)

| `outcome` | Shown |
|---|---|
| `processed` | "Handled" |
| `unknown_sender` | "Dropped: sender not on the list" |
| `sender_not_verified` | "Dropped: sender could not be confirmed" |
| `rate_limited` | "Dropped: too many emails in an hour" (the hourly number is a server setting the screen does not know) |
| `no_pdf` | "No PDF attached" |
| `too_large` | "Email too large to open" |
| `auto_reply_ignored` | "Ignored: automatic reply" |
| `error` | "Could not be handled" (in `--crit`) |
| anything new | The raw value, so a new outcome is never hidden |

### 6.4 Files cell

- Build it from the counts, leaving out the zero parts: "3 PDFs: 1 loaded, 1 held, 1 refused"; "1 PDF: loaded"; "12 PDFs: 10 loaded, 2 skipped (over 10 per email)".
- `file_count` 0: "No PDFs".
- "loaded" covers drafts, drafts that need a report type and released files (API.md). "refused" covers duplicates. The cell does not say which; the reply to the sender did.

### 6.5 States

| State | What is shown |
|---|---|
| Loading (first time) | `working-panel`: "Loading the email log…" |
| Loading another page | The table stays, the paging buttons are disabled, the count line reads "Loading…" |
| Empty | `hint-text`: "No email received yet." When intake is off, add: "Email intake is off, so nothing is received." |
| Error loading | `banner banner-crit`, `role="alert"`: "Could not load the email log. Check your connection and try again." with **Try again** |
| Page past the end (rows were pruned) | Go back to the first page silently |

## 7. "By email" marker in the Reports list (SL-81)

- In `ReportRow`, inside the "Status" cell, after the status pill, when `source_channel === 'email'`: `<span className="status-pill source-pill"><span aria-hidden="true">By email</span><span className="sr-only">Received by email</span></span>`. Web uploads have no marker; that is the normal case.
- The phone card shows the same cell, so the marker comes along.
- In the "Not read yet" group, the date cell says "received 2026-11-13" for email and keeps "uploaded 2026-11-13" for web.
- The label and the address are never in the list (a list can be screen-shared or shown on a wall screen).
- The marker uses grey (`surface-2`), not a status colour: where a report came from is not a problem.

## 8. Source line (report page and the Continue flow, SL-81)

### 8.1 Text

| Source | Line 1 | Line 2 |
|---|---|---|
| Email | "Received by email · Flow core team · 13 Nov 2026, 09:14" | "Sent from lab-team@example.org" |
| Web (`source` is `null`) | "Uploaded in the app · 13 Nov 2026, 09:14" (the report's `created_at`) | none |
| Web, after sign-in exists (AC-31, later) | "Uploaded in the app by Flow core team · 13 Nov 2026, 09:14" | none |

- `<p className="source-line" data-testid="source-line">`. Line 2 is a separate `<span className="ei-addr">` on its own line, so a long address wraps and does not push the date off screen.
- "Received by email" and the label are plain text; the time is a `<time>`.
- The label and address are the ones recorded at intake (AC-30). Do not look them up again in the allow list.

### 8.2 Where

- **Report page** (`ReportDetailScreen`), every status: directly under the heading's meta line ("2026-11-02 · Draft"), inside the heading block passed to the review header, so it sits with the other facts about the report. Not inside the field list, not in the PDF, not in the CSV (AC-29).
- **Report page of an unread draft** (9): at the top of the unread panel.
- **Continue flow** (10): in the info banner at the top.
- AC-28 asks for the sender, label and time on the draft and on the report page. A draft is opened on its report page, so the address is shown there for drafts too. It is not shown in the list (7), the held list (5) or toasts.

## 9. Report page of a draft that is not read yet (SL-81 text, SL-85 Continue)

Today such a page shows "No template could be resolved for this report…". For a report that is not read yet (status `draft` or `classified`, no extracted fields) replace that sentence with the unread panel (`unread-panel`):

1. Heading (`section-title`): "Not read yet" (the same words as the Reports group).
2. The source line (8).
3. One banner by state (table below).
4. The buttons: **Continue** (`btn primary`) where the table says so; **View original scan** (`btn small`, as now); **Delete report** stays where it is today.

| Condition (from `ReportOut.source` and the report) | Banner | Continue |
|---|---|---|
| `needs_report_type` is true | `Notice tone="warn"`: "**Needs a report type.** The app did not recognise this kind of report, so it has not read it. Choose Continue to pick the instrument and report type. If there is no form for it yet, you can make one from this report." | Shown |
| `read_state` = `waiting_for_limit` | `Notice tone="info"`: "**Waiting for the daily limit.** The app has read as many reports today as it may. This report will be read after the limit resets. Nothing for you to do." | Not shown |
| `read_state` = `queued` | `Notice tone="info"`: "**Being read now.** This usually takes under a minute." with `btn small` **Check again** (reloads the report) | Not shown |
| `read_state` = `needs_person` | `Notice tone="warn"`: "**Not read yet.** The app could not finish reading this report on its own. Choose Continue to check the instrument and report type, then read it." | Shown |
| Web draft, no source (any unread web upload) | `Notice tone="warn"`: "**Not read yet.** This report was uploaded but not read. Choose Continue to finish it." | Shown |

- **Continue** has `aria-describedby` pointing to the banner text, so its purpose is announced.
- The texts do not name the daily number (60): the screen does not get it from the API, and it may change.
- Once the report is read, the page is the normal report page with the source line under the heading.

## 10. Continue an unread draft (SL-85)

### 10.1 Route

**Continue** opens the New report flow for that report. Recommended address: `#/new/<report-id>`, with the New report tab shown as current. A reload must land in the same place (the step is worked out again from `GET /reports/{id}/intake-state`). The frontend may choose another address if it keeps these two properties.

### 10.2 What the flow shows

- At the top, `Notice tone="info"`:
  - Email: "Continuing a report received by email from Flow core team on 13 Nov 2026, 09:14 (lab-team@example.org)."
  - Web: "Continuing a report uploaded on 13 Nov 2026, 09:14."
  - With a `link-button` **Back to the report** (to `#/reports/<id>`; the existing unsaved-changes guard applies).
- The step bar shows "Upload" as done (✓). The file chooser and the drop zone are not shown: the file is already there.
- The working panel shows the generated file name ("emailed-report-1.pdf") if it shows one at all; there is no original name.

### 10.3 Which step

Worked out from `intake-state` in `intakeResume.ts` (Vitest for each row):

| State | Step shown |
|---|---|
| Translation running or queued | Working panel "Translating the report…" (wait for it; do not start another) |
| Translation done, needs review | The existing translation review |
| Classify running or queued | Working panel "Reading the instrument and visit type…" (the existing text; wait) |
| `needs_report_type`, classify unsure, or classify failed | Classify step (the existing confirm-classification screen). For `needs_report_type` add `Notice tone="warn"` above it: "The app did not recognise this kind of report. Choose the instrument and the report type. If there is no form for it yet, choose Make a form from this report." (Use the existing template-suggestion button and its own label; replace "Make a form from this report" in this text with that label.) |
| Classify done, extract running or queued | Working panel "Reading the fields from the document…" (existing text; wait) |
| Extract failed | The existing error step with **Try again** |
| Extract done | Review & finalize, as for a web upload |
| `waiting_for_limit` | `Notice tone="info"` with the "Waiting for the daily limit" text from 9, and only **Back to the report**. (Continue is not offered then, but a bookmarked address can still land here) |

### 10.4 Failure paths

| Case | What is shown |
|---|---|
| The report was finalized or read in the meantime | Go to `#/reports/<id>` and show the toast "This report is already read." |
| The report does not exist (404) | `banner banner-crit`: "This report no longer exists. Someone may have deleted it." with `btn` **Go to Reports** |
| `intake-state` fails to load | `banner banner-crit`: "Could not open this report. Check your connection and try again." with **Try again** and **Back to the report** |
| The person leaves half way | Nothing is lost: the draft stays in "Not read yet" and can be continued again |

## 11. Accessibility

- **Names.** Every field has a visible `<label>`. The radio pair has a `<fieldset>` and `<legend>`. Row buttons carry `aria-label`s that name the row (4.5, 5.2). The "Actions" header cells are `sr-only`. Tables have a `caption` (`sr-only`) and `scope="col"` headers.
- **Scrolling tables.** Every table wrapper is `tabIndex={0} role="region" aria-label="..."` with the label from this brief (axe).
- **Focus order.** Side menu, then the Email intake links, then the status line's Copy address, then the part's own content top to bottom: add button or form, banners, table rows left to right. Focus moves are listed with each action (4.2, 4.5, 5.3, 5.4). Every control shows the 2px `accent` focus outline.
- **Messages.** Errors: `role="alert"`. Success banners: `role="status"`. Confirm banners: `role="alertdialog"` with an `aria-label`; Escape cancels. Toasts are the existing live region.
- **Never colour alone.** "Not sent", "Could not be handled", the amber count and the "Off" pill all carry words.
- **Keyboard.** Everything works with Tab, Enter and Space; there are no hover-only controls and no drag.
- **Contrast.** 3.4; every text pair is at least 4.5:1 in light and dark.
- **Reduced motion.** Nothing new moves.

## 12. Phone (up to 620px) and tablet (621 to 900px)

- **Navigation.** Bottom tab bar More > Admin > Email intake. The Admin side menu is the existing sideways-scrolling row; "Email intake" is one more item in it. The three Email intake links wrap onto two lines when needed (`ei-subnav` wraps), each at least 44px tall (the existing phone rule for `.btn`).
- **Inputs at 16px.** The base input rule is 0.88rem (about 14px), which makes a phone browser zoom in. In this file, at `max-width: 620px`, set `font-size: 1rem` on the inputs of these screens (`.ei-section input`, including `type="email"`). Inputs and selects are already 44px tall at this width.
- **Touch targets.** Buttons are 44px tall (existing rule). The radio labels, "Open the draft", "Back to the report" and "Copy address" are at least 44px tall too (`link-button` already is on phones).
- **Tables become cards.** At `max-width: 620px` for Allowed senders, and at `max-width: 900px` for Held and the Email log (five columns are too tight on a tablet): each row is a block with `border-bottom: 1px solid var(--border)` and `padding: var(--space-3) 0`; the header row is hidden (keep it in the markup for screen readers: `sr-only` look, not `display: none`); each cell is on its own line with its column name before it in `text-faint` (`data-label` attribute and `::before`, the same way the Reports cards do it). No sideways scrolling.
- **Row buttons on a card.** In a row that wraps; "Load as draft" first and full width on its own line, "Open PDF" and "Delete" side by side below it. "Change team or role" and "Remove" side by side.
- **Confirm banners.** Buttons full width, stacked, "Confirm …" first, as on the report page.
- **Long text.** Addresses (up to 254 characters) and labels (up to 60) wrap anywhere; nothing is cut off with "…".
- **Report page.** The source line wraps; line 2 (the address) stays on its own line. The unread panel's **Continue** is full width.

## 13. Privacy rules for these screens

- The sender address appears in exactly four places: the Allowed senders list, its remove confirmation, the Email log (allowed senders only), and the source line on the report page and the Continue banner. Nowhere else: not in the Reports list, the held list, toasts, the page title (`document.title`), the address bar, console output or error messages built by the frontend.
- No subject, body text or original file name appears anywhere: none is stored.
- A team or role label is never a person's name (R-18). The form says so; the API cannot check it.
- Screenshots, tests and demo data use invented `example.org` and `example.com` addresses and invented team names (CLAUDE.md, AC-32). The examples in this brief ("lab-team@example.org", "Flow core team", "Imaging core") are invented.

## 14. Not in this brief (later or other tasks)

- The text of the reply email (SL-77).
- A filter on the Reports list by source or team (deferred in PLAN.md).
- A Home screen tile for "files to check" or "reports waiting for the daily limit" (no task touches Home; see Open questions).
- The uploader of web reports, after sign-in (AC-31).

## 15. Checks for the review after the build

Screenshots at 1400, 768 and 390px, light and dark, of: Allowed senders (empty, with 1 address and 1 domain with a 254-character address and a 60-character label, the add form with every error, the public-domain warning, the remove confirmation); Held (empty, 2 rows, after Load as draft for each `read_state`, the delete confirmation); Email log (one row per outcome, two pages); status line on and off; the report page of an emailed report (read and each unread state) and of a web report; a Reports list with an emailed row, on a phone card too; the Continue flow from "Needs a report type". Keyboard-only run through add, change, remove, load and delete. axe on each Admin part.

## Open questions

- Q1 (assumed): warn, not block, when a public mail domain such as gmail.com is added as a whole domain (4.4). Cheap to change.
- Q2 (assumed): no paging on the held list. If it can grow past about 50 files, the API needs paging (an API change).
- Q3 (later, product-manager): should Home show "N files to check" and "N reports waiting to be read"? Not in the brief, not planned.
- Q4 (assumed): "Open PDF" for a held file whose stored file is missing shows the browser's 404 page in the new tab. Acceptable for the demo; a nicer page needs backend work.

## Notes for the lead (outside this feature)

- Seen in the code, not checked in a browser: the app has no rule that makes inputs 16px on phones (the base rule is 0.88rem). This brief adds it for the email intake screens only; the rest of the app may zoom on iPhones when a field is tapped. Worth its own small frontend task.
- `input[type='email']` has no base style in the app today (3.3).
