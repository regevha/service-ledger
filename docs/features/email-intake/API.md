# Email intake: API contract

Owner: architect. Date: 2026-11-13. Source: `docs/features/email-intake/PRODUCT.md` (AC-01 to AC-33).
Frozen during a wave. Changes go through "Contract change requests" in `docs/features/email-intake/PLAN.md`.

The mailbox is never reached through the API. The worker polls it (see PLAN.md, "Conventions").
The API only manages the allow list, shows the log and the held files, and shows where a report came from.
After every API change the task runs `cd frontend && npm run codegen` and commits `src/generated/api-schema.ts`.

## Error order (every endpoint here)

The repo-wide order from `docs/PLAN.md` "Error precedence" applies, unchanged:

1. `401` no or wrong shared password (middleware, before routing). After Wave C: no or bad token.
2. `403` (after SL-42 only) a read-only user on a write endpoint. Fires before body validation.
3. `422` path, query or body validation, and `InvalidError`.
4. `404` `NotFoundError`.
5. `409` `ConflictError`.
6. `429` is never returned by these endpoints. The daily job limit does not refuse email work: a file waits instead (AC-16).

Error bodies are `{"detail": "<plain English sentence>"}`, as everywhere else in the app.
No error message quotes an email address, subject, body or attachment name except the address the admin just typed.

"Admin" today means anyone past the shared password (the Admin screen is open to everyone, see Open question A in PLAN.md).
After SL-42, every write route below must carry `require_editor` (CCR-E01).

## Shared shapes

```text
AllowKind        = "address" | "domain"
SourceChannel    = "email" | "web"
ReadState        = "queued" | "waiting_for_limit" | "needs_person"
MessageOutcome   = "processed" | "unknown_sender" | "sender_not_verified" | "rate_limited"
                 | "no_pdf" | "too_large" | "auto_reply_ignored" | "error"
FileOutcome      = "loaded" | "needs_report_type" | "held" | "released" | "held_deleted" | "refused" | "duplicate"
ReplyStatus      = "none" | "pending" | "sent" | "failed"
```

## 1. Allow list (AC-20, AC-21, AC-30, AC-32)

### `GET /email-intake/allowed-senders`
200: `AllowedSenderOut[]`, ordered by `kind` (addresses first), then `value`.

```json
{ "id": "uuid", "kind": "address", "value": "lab-team@example.org", "label": "Flow core team", "created_at": "2026-11-13T09:00:00Z" }
```

### `POST /email-intake/allowed-senders`
Body `AllowedSenderCreate`:
```json
{ "kind": "domain", "value": "example.org", "label": "Imaging core" }
```
Rules (checked in `services/allow_list.py`, raised as `InvalidError` -> 422):
- `value` is trimmed and stored lower-case.
- `kind = "address"`: exactly one `@`, a non-empty local part, a domain with at least one dot, no spaces, at most 254 characters.
- `kind = "domain"`: no `@`; dot-separated labels of letters, digits and hyphens; at least one dot; at most 253 characters. A leading `@` is removed before the check.
- `label`: trimmed, 1 to 60 characters, must not contain `@`. It names a team or a role, not a person (R-18; the screen says so, the API cannot check it).

201: `AllowedSenderOut`. 422: rule broken (message says which). 409: `"This address is already on the list."` / `"This domain is already on the list."`.

### `PATCH /email-intake/allowed-senders/{id}`
Body `{ "label": "New label" }` (same label rule). 200: `AllowedSenderOut`. 422, then 404.
Reports already loaded keep the old label (AC-30): the label is copied into `report_sources` at intake time.

### `DELETE /email-intake/allowed-senders/{id}`
204. 404 when missing. Takes effect for the next message the worker handles (AC-21). Drafts and their recorded source stay (AC-21, AC-30).

## 2. Status (admin screen header)

### `GET /email-intake/status`
200: `EmailIntakeStatusOut`, read from settings only (no secrets):
```json
{ "enabled": true, "mailbox": "folder", "sender": "folder", "intake_address": "intake@example.org",
  "max_pdfs_per_message": 10, "max_pdf_megabytes": 20, "poll_interval_seconds": 60 }
```
`intake_address` is `null` when `EMAIL_INTAKE_ADDRESS` is empty. `mailbox` is `"folder" | "imap"`, `sender` is `"folder" | "smtp"`.

## 3. Intake log (AC-11, AC-12)

### `GET /email-intake/log?limit=50&offset=0`
`limit` 1 to 200 (default 50), `offset` >= 0. Newest first. 200:
```json
{ "total": 3, "items": [ {
  "id": "uuid", "received_at": "...", "outcome": "processed", "reason": null,
  "file_count": 3, "files_loaded": 1, "files_held": 1, "files_refused": 1, "files_skipped": 0,
  "sender_address": "lab-team@example.org", "sender_label": "Flow core team", "reply_status": "sent" } ] }
```
- `sender_address` and `sender_label` are `null` unless the sender was on the allow list (AC-12).
- `reason` is fixed app text (for example `"Sender is not on the allow list."`), never text from the message.
- No body, subject or attachment name exists to return (they are never stored).
- `files_loaded` counts `loaded` + `needs_report_type` + `released`; `files_refused` counts `refused` + `duplicate`; `files_held` counts `held` + `held_deleted`.

## 4. Held files: "Check: maybe not a service report" (AC-10 outcome 4, AC-26)

### `GET /email-intake/held`
Only files whose outcome is `held`. Oldest first. 200:
```json
[ { "id": "uuid", "received_at": "...", "sender_label": "Flow core team",
    "reason": "The file has no text to check. A person must look at it.", "page_count": 2, "size_bytes": 183204 } ]
```

### `GET /email-intake/held/{id}/file`
200 `application/pdf`, `Content-Disposition: attachment; filename="held-file.pdf"`, `X-Content-Type-Options: nosniff`.
`?inline=1` serves it inline (same rule as `GET /attachments/{id}/file`). 404 when the file is not held or not on disk.
A held file has passed the structural PDF check (AC-08) before it is kept.

### `POST /email-intake/held/{id}/release`
No body. Creates a draft report with the file as its attachment, records its source, and queues reading
(classify, then extract automatically) or marks it `waiting_for_limit` when the daily limit is reached. Never 429.
200:
```json
{ "report_id": "uuid", "read_state": "queued" }
```
404 not found. 409 `"This file was already released or deleted."`.

### `DELETE /email-intake/held/{id}`
204. Deletes the stored PDF. The log entry stays, with the file outcome `held_deleted`. Creates nothing.
404 not found. 409 `"This file was already released or deleted."`.

## 5. Where a report came from (AC-03, AC-27, AC-28, AC-29)

### `ReportOut.source` (on `GET /reports/{id}` and every endpoint that returns `ReportOut`)
New optional field, `null` for a web upload (the screen then says "Uploaded in the app" with `created_at`):
```json
"source": { "channel": "email", "sender_address": "lab-team@example.org", "sender_label": "Flow core team",
            "received_at": "...", "read_state": "needs_person", "needs_report_type": true }
```
`read_state` and `needs_report_type` come from the intake file row; both are `null`/`false` once the report has no intake row.

### `ReportListItemOut.source_channel`
New field `"email" | "web"` on `GET /reports`, `GET /reports/{id}/item` and `GET /reports/{id}/duplicates`. Used for the "Received by email" marker in lists.

### Not changed (AC-29)
`GET /reports/export` (CSV) and `GET /reports/{id}/pdf` keep their columns and content. The source never appears in them,
in `extracted_fields`, or in `search_text`. SL-86 tests this.

## 6. Continue an unread draft (AC-01, AC-10 outcome 2)

### `GET /reports/{report_id}/intake-state`
What the intake screen needs to pick up a draft where it stopped. 200:
```json
{ "report_id": "uuid", "status": "draft", "attachment_id": "uuid",
  "translation_status": null,
  "latest_jobs": { "translate": null, "classify": { "...": "ExtractionJobOut" }, "extract": null },
  "source": { "...": "ReportSourceOut or null" } }
```
`attachment_id` is the report's first attachment (oldest), `null` when it has none. `latest_jobs` holds the newest job of each kind
for that attachment (`ExtractionJobOut`, unchanged shape) or `null`. 404 when the report does not exist.
This endpoint is read-only and not email-specific; web drafts use it too.

## 7. Not in the API (on purpose)

- No endpoint receives an email or drops one into the fake mailbox. The demo uses a CLI
  (`python -m app.tools.email_demo_send`) and the tests write `.eml` files to the fake inbox folder.
- No endpoint returns replies. Fake replies are `.eml` files in `EMAIL_FAKE_OUTBOX_DIR`.
- No endpoint changes mailbox or SMTP settings. They are environment variables only.
