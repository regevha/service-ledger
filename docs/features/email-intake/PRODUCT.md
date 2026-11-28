# Email intake: product brief

Status: questions answered 2026-11-13; ready for the architect. No open product questions.
Owner: product-manager. Date: 2026-11-13.

## Problem and users

The user's words (translated from Hebrew): "Loading reports: add an option to send to a dedicated mailbox that receives PDFs, checks that they are safe and relevant, and if so loads them into the system, before final approval. Maybe also an option to confirm the details in a reply email. The system will need to load the report for the relevant user according to the email it was received from. We also need to create this mailbox, but for the demo we can use Gmail or something like that."

Today a report enters only through the web upload (single file or batch on Home). The worker then translates, identifies and reads it, and a person checks and approves it on the review screen.

Users:
- **Sender**: a core facility manager or technician who has a service report PDF (often forwarded by the vendor) and would rather email it than open the app.
- **Approver**: the person who checks and approves reports. Today this is anyone behind the shared password. Per-user sign-in is planned (Wave C, SL-38 onward) but not built.
- **Admin**: manages the allow list and the "Check: maybe not a service report" list.

## Goals

- A person emails a PDF to one dedicated address and the report appears in the app as a draft, ready to check.
- Unsafe or irrelevant mail never reaches the reading step, and the allowed sender is told why.
- Every report shows and records where it came from.
- Nothing is approved by email intake. A person still checks and approves in the app.

## Non-goals (not built in the first version)

- Auto-approval of any report.
- Reading the email body as report content, or storing it.
- Any reply-email confirmation or correction (see US-6, `later`).
- Several mailboxes, per-institute mailboxes, mail rules or folders.
- Creating or hosting the production mailbox (a deployment task for the owner; the app only needs its connection details).
- Sign-in, roles and user accounts (separate plan, SL-38 onward).
- A real malware scanner (`later`, with the production mailbox).
- Live Claude calls in the demo (stub mode stays the default).

## User stories and acceptance criteria

### US-1 Send a report by email (must)
As a sender, I email a PDF to the intake address and get the report as a draft in the app.

- AC-01 (must): An email from an allowed sender with one PDF attachment that is a recognised service report produces one draft in the app, shown with the same reading result as a web upload of that file. It is not approved.
- AC-02 (must): An email with several PDFs produces one outcome per PDF, up to 10 per email. Files beyond that are left out and the sender is told.
- AC-03 (must): Drafts from email are marked "Received by email" and show the received time, so the approver can tell them from web uploads.
- AC-04 (must): The first version works without a real mailbox: a local fake mailbox (a folder or a test double the app reads from) lets the demo and the tests send a message and see the draft. Gmail is an optional real mailbox for the demo.
- AC-05 (must): An email with no attachment, or only unsupported ones, creates nothing and an allowed sender gets a short reply saying what to send.

### US-2 Unsafe or irrelevant mail is stopped (must)
As the owner, I want only safe service reports to reach the reading step.

- AC-06 (must): Only PDF attachments are taken. Images, Office files, archives, executables, scripts and any file whose content is not really a PDF (wrong type for its name) are refused.
- AC-07 (must): A PDF over the existing PDF upload limit (20 MB today) is refused with the limit stated. Web and email share the one limit.
- AC-08 (must): The structural PDF check refuses a PDF that is not a real PDF, is encrypted, is damaged or has no readable pages, or contains JavaScript, launch actions or embedded files. Such a file is never opened by the reading step. The sender is told "could not be accepted" without technical detail.
- AC-09 (must): Text in the email subject, body or PDF that tries to give the system instructions has no effect: it changes no setting, sender, role or report field. The tester checks this with an invented example.
- AC-10 (must): Relevance means "is this a service report for a lab instrument", not "do we already have its template". Each PDF ends in exactly one of four outcomes:
  1. Recognised form: loads as a draft and is read as usual.
  2. Service report with no matching template (new maker or report type): loads as a draft marked "needs a report type". A person picks or creates the type before it is read, using the existing template-suggestion step. Not read by Claude before that.
  3. Clearly not a service report (invoice, CV, random PDF, a malicious test file): refused, and the allowed sender is told why. Nothing is kept (R-9).
  4. Unsure: held in a separate "Check: maybe not a service report" list. It is not read by Claude (so it does not use the daily cap) and is not in the review list. An admin can release it for reading or delete it.
- AC-11 (must): Mail from an address or domain that is not on the allow list creates nothing and gets no reply (R-4). The refusal is visible to admins in a log or screen.
- AC-12 (must): Every refused or held message leaves an admin-visible entry: time, outcome, reason, number of files. It holds no body text and no attachment name. It holds the sender address only for allowed senders.
- AC-26 (must): The "Check: maybe not a service report" list shows, for each held file, the received time, the sender label and the reason it was held. An admin can release or delete each one, and the screen says exactly what delete removes.

### US-3 Know what happened (must)
As an allowed sender, I want to know if my email worked. One short email per message, never one per file.

- AC-13 (must): Within 5 minutes of sending (stub mode, demo-size files), an allowed sender gets exactly one reply per email. It covers every file in it and says one of: "received, waiting for approval"; "held for a check"; "refused", with the reason in plain words. A mixed email lists each file's outcome in the one reply.
- AC-14 (must): Replies never contain extracted field values, other people's data, or a link that works without sign-in or the shared password.
- AC-15 (must): A reply goes only to an allowed sender, to the address the message came from, never to a Reply-To or other header address. Replies carry no instruction to reply with content; the first version reads no replies (US-6).
- AC-16 (must): If the daily limit of Claude jobs (60) is reached, the email is not lost: the sender is told it is waiting and the report is read after the limit resets (R-8). Files held under outcome 4 never use the cap.

### US-4 Duplicates (must)
- AC-17 (must): The same PDF bytes as a report already read are not loaded again. The reply says it is already in the system, without opening it to the sender.
- AC-18 (must): The same email delivered twice (same message ID) creates outcomes once and sends one reply.
- AC-19 (must): A matching work-order number only warns on the draft, as for web upload. It never blocks.

### US-5 Whose report is it, and where it came from (must)
- AC-20 (must): The admin allow list holds single addresses and whole domains. Each entry has a team or role label (for a domain, one label for the whole domain). A draft from a listed sender is loaded for that label and shows it on the review screen.
- AC-21 (must): Only an admin can add, remove and list allow-list entries. Removing one stops new mail at once and does not delete existing drafts.
- AC-27 (must): Each email-sourced report records where it came from: the sender address (as received), the label that matched, the received time and how it arrived (email). This is stored beside the report, not in a report field.
- AC-28 (must): The source (sender, label, received time) is shown inside the app on the draft and on the report page, for web uploads as well as email ("Uploaded in the app" for web, with the uploader once sign-in exists).
- AC-29 (must): The source never appears in report fields, the CSV export, or anything shared with another institute. A tester exports a report that came by email and finds no sender address or label.
- AC-30 (must): If a sender's allow-list entry is later removed or changed, the source already recorded on past reports stays as it was.
- AC-31 (later): When sign-in arrives, a label is linked to a user row, and the uploader is recorded for web uploads the same way.

### US-6 Reply-email confirmation and corrections (later)
- AC-22 (later): Reply-email confirmation is not in the first version. One notification email per message is all the sender receives, and replies to it are ignored.
- AC-23 (later, trigger): If reading accuracy stays below 99%, replies that carry corrections (option C in the old Q3) may be added. Needs its own brief: matching a reply to its draft, accepting it only from the original sender within a time limit, and a second approval by a person.

### US-7 Privacy (must)
- AC-24 (must): Email body text, subject, attachment names and sender addresses never appear in any report field, prompt, fixture, log line or screenshot. Document text taken from PDFs goes through the same rules as other uploads (`services/privacy.py`).
- AC-25 (must): The body is not stored. The sender address is stored only as provenance (AC-27) and in the allow list. Raw message copies are deleted once handled (R-9).
- AC-32 (must): The allow list lives in the database and is managed only by admins. No address is in the repo, seed files, fixtures or tests (tests use invented addresses at a reserved example domain).

### US-8 Real malware scanning (later)
- AC-33 (later): A real malware scanner is added as an extra layer with the production mailbox. The structural PDF check (AC-08) stays.

## Product rules

| # | Rule | Status |
|---|------|--------|
| R-1 | Email intake only makes drafts. A person approves in the app. | decided (user: "before final approval") |
| R-2 | PDF only. Images stay web-upload only. | assumed |
| R-3 | Same size limit and duplicate rules as web upload. | assumed |
| R-4 | Mail from unknown senders is dropped silently (no reply). | decided 2026-11-13 (Q5: unknown senders get nothing) |
| R-5 | One intake address for the whole app. | assumed |
| R-6 | Stored about a message: received time, message ID, outcome, and for allowed senders the address and matched label. Nothing from the body. | assumed |
| R-7 | Email counts toward the 60 Claude jobs per day, same as web upload. Held files (outcome 4) do not. | decided (daily cap; Q4) |
| R-8 | When the daily cap is hit, the email waits and is read after the reset; the sender is told. | assumed |
| R-9 | A refused file is not kept. The raw message is deleted when handled. Held files are kept only until an admin releases or deletes them. | assumed |
| R-10 | Max 10 PDFs per email. A sender may send at most 20 emails per hour; more are dropped. | assumed |
| R-11 | Allow list of addresses and whole domains, each with a team or role label, managed by admins, stored in the database. A listed sender's mail loads as a draft for that label. The label links to a user row when sign-in arrives. | decided 2026-11-13 (Q1, Q2) |
| R-12 | No reply-email confirmation in the first version. One notification email per message. Corrections by reply may come later if accuracy stays below 99%. | decided 2026-11-13 (Q3) |
| R-13 | Gmail for the demo; the production mailbox is created by the owner. Credentials are secrets, never in the repo. | decided (user: Gmail for the demo) |
| R-14 | English UI and English replies. | decided |
| R-15 | The source (sender address and label) is stored as provenance beside the report, not as a report field. It is shown inside the app, and stays out of report fields, the CSV export and anything shared with another institute. | assumed (lead's reading of "show and document where the report came from"; user may overrule) |
| R-16 | Relevance = "a service report for a lab instrument", with four outcomes (AC-10). | decided 2026-11-13 (Q4) |
| R-17 | Reply to allowed senders only, one short email per message. The demo uses the structural PDF check; a real scanner is `later`. | decided 2026-11-13 (Q5) |
| R-18 | Labels are team or role names, not personal names. | assumed (privacy rule) |

## Open questions

None. Q1 to Q5 were answered by the user on 2026-11-13 (see Changes).

## Cheap details, assumed (tell me to change any)
R-2, R-3, R-5, R-6, R-8, R-9, R-10, R-15, R-18; the 5-minute reply time in AC-13 and the 10-file limit in AC-02.

## Changes

- 2026-11-13: User answered Q1 to Q5.
  - Q1 (A): allow list with labels. Recorded as R-11; AC-20, AC-21 updated.
  - Q2 (A, B and C): addresses stay in the admin allow list; whole domains allowed; where a report came from is shown and recorded. Added AC-27 to AC-30, AC-32; R-15 recorded as `assumed`. This replaces the earlier "never show the sender" wording in AC-03.
  - Q3 (A now, C later): confirmation stories moved to `later` with the 99% accuracy trigger (AC-22, AC-23, R-12).
  - Q4 (new option): relevance is "a service report for a lab instrument", four outcomes. Rewrote AC-10, added AC-26 for the held list, updated R-7, R-9, R-16.
  - Q5 (A): one reply per message to allowed senders only. AC-13 and AC-15 updated; structural PDF check in AC-08; real scanner `later` (AC-33); R-4 and R-17 decided.
  - No build had started, so no tasks are affected yet.
