# Email intake: product brief

Status: draft, waiting for the user's answers (see "Open questions").
Owner: product-manager. Date: 2026-11-13.

## Problem and users

The user's words (translated from Hebrew): "Loading reports: add an option to send to a dedicated mailbox that receives PDFs, checks that they are safe and relevant, and if so loads them into the system, before final approval. Maybe also an option to confirm the details in a reply email. The system will need to load the report for the relevant user according to the email it was received from. We also need to create this mailbox, but for the demo we can use Gmail or something like that."

Today a report enters only through the web upload (single file or batch on Home). The worker then translates, identifies and reads it, and a person checks and approves it on the review screen.

Users:
- **Sender**: a core facility manager or technician who has a service report PDF (often forwarded by the vendor) and would rather email it than open the app.
- **Approver**: the person who checks and approves reports. Today this is anyone behind the shared password. Per-user sign-in is planned (Wave C, SL-38 onward) but not built.

## Goals

- A person emails a PDF to one dedicated address and the report appears in the app as a draft, read and ready to check.
- Unsafe or irrelevant mail never reaches the reading step, and the sender is told why.
- Nothing is approved by email intake. A person still checks and approves in the app.

## Non-goals (not built in the first version)

- Auto-approval of any report.
- Reading the email body as report content, or storing it.
- Replying with edits in free text ("change the date to ...").
- Several mailboxes, per-institute mailboxes, mail rules or folders.
- Creating or hosting the production mailbox (a deployment task for the owner; the app only needs its connection details).
- Sign-in, roles and user accounts (separate plan, SL-38 onward).
- Live Claude calls in the demo (stub mode stays the default).

## User stories and acceptance criteria

### US-1 Send a report by email (must)
As a sender, I email a PDF to the intake address and get the report as a draft in the app.

- AC-01 (must): An email from an allowed sender with one PDF attachment produces one draft report in the app, shown with the same reading result as a web upload of that file. It is not approved.
- AC-02 (must): An email with several PDFs produces one draft per PDF, up to 10 per email. Files beyond that are left out and the sender is told.
- AC-03 (must): Drafts from email are marked as "Received by email" and show the received time, so the approver can tell them from web uploads. They are not marked with the sender's address.
- AC-04 (must): The first version works without a real mailbox: a local fake mailbox (a folder or a test double the app reads from) lets the demo and the tests send a message and see the draft. Gmail is an optional real mailbox for the demo.
- AC-05 (must): An email with no attachment, or only unsupported ones, creates nothing and the sender gets a short reply saying what to send.

### US-2 Unsafe or irrelevant mail is stopped (must)
As the owner, I want only safe service reports to reach the reading step.

- AC-06 (must): Only PDF attachments are taken. Images, Office files, archives, executables, scripts and any file whose content is not really a PDF (wrong type for its name) are refused.
- AC-07 (must): A PDF over the existing PDF upload limit (20 MB today) is refused with the limit stated. The same limit applies to web and email.
- AC-08 (must): A PDF that is encrypted, damaged, has no readable pages, has active content (embedded scripts, launch actions, embedded files) or fails a malware scan is refused and never opened by the reading step. The sender is told "could not be accepted" without technical detail.
- AC-09 (must): Text in the email subject, body or PDF that tries to give the system instructions has no effect: it changes no setting, sender, role or report field. The tester checks this with an invented example.
- AC-10 (must): A PDF that is not a service report (the classifier finds no instrument or report type it knows) is not loaded as a draft. The sender is told it was not recognised as a service report. It is kept out of the report list (see rule R-9 for what is kept).
- AC-11 (must): Mail from an address that is not on the allowed list creates nothing. No reply is sent to it (see R-4), and the refusal is visible to admins in a log or a screen.
- AC-12 (must): Every refused or stopped message leaves an admin-visible entry: time, reason, number of files. It holds no body text, no attachment name and no sender address beyond what R-6 allows.

### US-3 Know what happened (must)
As a sender, I want to know if my email worked.

- AC-13 (must): Within 5 minutes of sending (stub mode, demo size files), the sender gets one reply per email. On success it says how many drafts were created and that a person still has to approve them. On failure it says which file failed and why in plain words.
- AC-14 (must): Replies never contain extracted field values, other people's data or a link that works without sign-in or the shared password.
- AC-15 (must): A reply is sent only to an allowed sender, to the address the message came from, never to a Reply-To or other header address.
- AC-16 (must): If the daily limit of Claude jobs (60) is reached, the email is not lost: the sender is told it is waiting, and the report is read when the limit resets, or the sender is told to resend. Which of the two is rule R-8.

### US-4 Duplicates (must)
- AC-17 (must): The same PDF bytes as a report already read are not loaded again. The reply says it is already in the system, without opening it to the sender.
- AC-18 (must): The same email delivered twice (same message ID) creates drafts once.
- AC-19 (must): A matching work-order number only warns on the draft, as for web upload. It never blocks.

### US-5 Whose report is it (must for the answer, build depends on Q1)
- AC-20 (must): Each draft from email is linked to the person or label the sender address maps to (see Q1), and the review screen shows it.
- AC-21 (must): An admin can add, remove and list allowed sender addresses. Removing one stops new mail at once and does not delete existing drafts.

### US-6 Confirm by reply (later, depends on Q3)
- AC-22 (later): After reading, the sender gets a reply listing the main facts read (instrument, report type, date). Replying "yes" approves nothing by itself; it moves the draft to "confirmed by sender" for the approver.
- AC-23 (later): A "yes" from a different address than the original sender, or arriving after 7 days, is ignored.

### US-7 Privacy (must)
- AC-24 (must): Email body text, subject, attachment names and sender addresses never appear in any report field, prompt, fixture, log line or screenshot. They go through the same rules as other document text (`services/privacy.py`).
- AC-25 (must): The body is not stored. The sender address is stored only as needed to apply Q1 and the allow list. Raw message copies are deleted once handled (see R-9).

## Product rules

| # | Rule | Status |
|---|------|--------|
| R-1 | Email intake only makes drafts. A person approves in the app. | decided (user: "before final approval") |
| R-2 | PDF only. Images stay web-upload only. | assumed (email image attachments are mostly signatures and logos) |
| R-3 | Same size limit and duplicate rules as web upload. | assumed |
| R-4 | Mail from unknown senders is dropped silently (no reply), so the address cannot be probed and nobody can use the app to send mail to others. | assumed |
| R-5 | One intake address for the whole app. | assumed |
| R-6 | Stored about a message: received time, message ID, sender address (while it is on the allow list), outcome. Nothing else. | assumed |
| R-7 | Email counts toward the 60 Claude jobs per day, same as web upload. | decided (daily cap) |
| R-8 | When the daily cap is hit, the email waits in the queue and is read after the reset; the sender is told. | assumed |
| R-9 | A refused or non-service-report PDF is not kept. The raw message is deleted when handled, success or not. | assumed (retention can be raised later) |
| R-10 | Max 10 PDFs per email. A sender may send at most 20 emails per hour; more are dropped. | assumed |
| R-11 | Drafts are shared with the whole app (everyone behind the password sees them), until sign-in exists. | open (Q1) |
| R-12 | Reply-email confirmation is not in the first version. | open (Q3) |
| R-13 | Real mailbox: Gmail for the demo; production mailbox is created by the owner on Azure or Microsoft 365. Credentials are secrets, never in the repo. | decided (user: Gmail for the demo) |
| R-14 | English UI and English replies. | decided |

## Open questions (most important first)

### Q1. Which user does a report belong to, given there are no accounts yet?
The user wants the report loaded "for the relevant user according to the email it was received from". No users exist today.
- A. Allow list of sender addresses, each with a display name (for example a first name or a team label). Drafts show that label. When sign-in arrives, each entry is linked to a user row.
- B. All email drafts land in one shared "Email inbox" list. Owner mapping waits for sign-in.
- C. Wait until sign-in (SL-38+) is built, then do email intake.
Recommendation: A. It gives the user what was asked, works in the demo, and the allow list is also the safety check for unknown senders. The label must be a team or role name, not a full personal name, to respect the privacy rule (see Q2).
Blocks: AC-11, AC-20, AC-21, the data model, and the architect's plan.

### Q2. May the allow list hold personal email addresses, and may the app show who sent a draft?
Reports are shared between institutes. An email address is contact detail.
- A. Addresses are stored only in the allow list (admin screen), never in report fields or on shared reports. The draft shows the label from Q1 only inside this app.
- B. Allow whole domains (for example the institute's domain) instead of single addresses; no per-person label.
- C. Show the address on the draft.
Recommendation: A, with B as an optional extra later. C breaks the privacy rule.
Blocks: AC-03, AC-24, AC-25, R-6.

### Q3. Is the reply-email confirmation wanted now?
- A. Not in the first version (marked "later").
- B. Yes, in the first version: reply "yes" moves the draft to "confirmed by sender".
- C. Reply with corrections too.
Recommendation: A. It needs reply-thread matching and a second security check, and adds little while a person approves anyway. Revisit when sign-in exists.
Blocks: AC-22, AC-23, R-12.

### Q4. What should "relevant" mean?
- A. The classifier must recognise an instrument and a report type it knows. Anything else is stopped (AC-10).
- B. Stricter: also require the instrument to already exist in the app.
- C. Looser: load everything that is a clean PDF and let the approver reject.
Recommendation: A. B blocks first reports of a new instrument; C wastes Claude jobs and fills the list.
Blocks: AC-10, R-9.

### Q5. Is a reply to the sender acceptable, and is a malware scan required in the demo?
- A. Reply to allowed senders only (R-4); in the demo the scan is the structural PDF check (AC-08) and a real scanner is added for the Azure mailbox.
- B. No replies at all. Result is shown only in the app.
- C. Real malware scanner required before the demo.
Recommendation: A. Replies are what the user asked for; a real scanner needs infrastructure the owner has not chosen yet.
Blocks: AC-08, AC-13, the Azure mailbox task.

## Cheap details, assumed (tell me to change any)
R-2, R-3, R-4, R-5, R-6, R-8, R-9, R-10 above; also the 5-minute reply time in AC-13 and the 10-file limit in AC-02.

## Changes
(none yet)
