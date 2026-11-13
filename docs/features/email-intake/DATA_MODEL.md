# Email intake: data model

Draft by architect, 2026-11-13. Built by `db-engineer` in SL-61 (2026-11-13), who owns it from now on.
No change below affects `API.md`.

One migration for the whole feature: `backend/alembic/versions/0017_email_intake.py`, revision `0017_email_intake`,
`down_revision = '0016_relative_attachment_paths'` (the head of `main` when it was built). **It is renumbered at merge
time**: PR #305 adds `0017_glossary_terms`, and the hardening plan queues more. Whoever merges last renames the file and
the revision id to the next free number and points `down_revision` at the head of `main` then. Reversible: the downgrade
drops the four tables and the five new enum types, nothing else. No existing column changes. The existing type
`extraction_job_kind` is reused, never created or dropped.

Models live in a new module `backend/app/models/intake.py`, registered in `models/__init__.py` after `.reports`
(they reference `reports`). `models/reports.py` gets one relationship, `Report.source`.
Every index and constraint is declared on the model too (tests build tables with `create_all`; CI runs `alembic check`).
Nothing is seeded: no row must exist in every database, so tests need no separate seeding path.

## Model and enum names (for backend-dev)

All importable from `app.models`.

| Table | Model | Relationships |
|---|---|---|
| `intake_allow_entries` | `IntakeAllowEntry` | none |
| `intake_messages` | `IntakeMessage` | `files` (list of `IntakeFile`, ordered by `position`, cascade delete) |
| `intake_files` | `IntakeFile` | `message`, `report` (one way: `Report` has no list of intake files) |
| `report_sources` | `ReportSource` | `report`, `intake_file` (lazy `select`; use `selectinload(Report.source).selectinload(ReportSource.intake_file)` where `ReportOut.source.read_state` is built for many reports) |
| `reports` | `Report` | new: `source` (`ReportSource | None`, `lazy="selectin"`) |

Enums (Python name = DB type name in CamelCase): `IntakeAllowKind`, `IntakeMessageOutcome`, `IntakeReplyStatus`,
`IntakeFileOutcome`, `IntakeReadState`, `ReportSourceChannel`; `waiting_kind` uses the existing `ExtractionJobKind`.
Constants `ADDRESS_MAX_LENGTH = 254` and `LABEL_MAX_LENGTH = 60` are in `app.models.intake`.
The plan's `match(db, address) -> AllowEntry | None` (SL-68) returns `IntakeAllowEntry`.

## Why four tables

- The allow list must be in the database and edited by admins (AC-20, AC-32).
- The admin log must keep one row per message, with no content (AC-12), and dedupe by message ID (AC-18).
- Each PDF in a message has its own outcome (AC-02, AC-10), and held files are listed from it (AC-26).
- Where a report came from is stored beside the report, not in a report field (AC-27, R-15), and must survive
  log pruning and allow-list edits (AC-30). That is why the label and address are copied into `report_sources`.

## `intake_allow_entries`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | `_uuid_pk()` |
| kind | enum `intake_allow_kind` (`address`, `domain`) | not null |
| value | varchar(254) | not null, **unique**, stored lower-case |
| label | varchar(60) | not null; a team or role name |
| created_at | timestamptz | server default now() |

Constraints (CHECK): `value = lower(value)`; an `address` has an `@` and a `domain` has none; `label` is not blank.
The service still trims and validates (API.md section 1); the database is the last line.

Later (AC-31, after SL-38): a nullable `user_id` FK to `users`. Not in this migration.

## `intake_messages`

One row per email the worker handled, whatever the outcome.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| message_key | varchar(64) | not null, **unique**, CHECK 64 lower-case hex characters. SHA-256 hex of the normalized `Message-ID` header; when it is missing, of the `Date` header plus the SHA-256 of every attachment. The raw Message-ID is not stored. |
| received_at | timestamptz | not null. Mailbox arrival time (IMAP INTERNALDATE, file mtime for the folder mailbox) |
| handled_at | timestamptz | not null, server default now() |
| sender_address | varchar(254) | null. Set **only** when the sender matched the allow list |
| sender_label | varchar(60) | null. The matched entry's label, copied |
| outcome | enum `intake_message_outcome` | `processed`, `unknown_sender`, `sender_not_verified`, `rate_limited`, `no_pdf`, `too_large`, `auto_reply_ignored`, `error` |
| reason | varchar(200) | null. Fixed app text only |
| file_count | int | not null default 0. Attachments seen (all types) |
| files_skipped | int | not null default 0. PDFs beyond the per-message limit (AC-02) |
| reply_status | enum `intake_reply_status` | `none`, `pending`, `sent`, `failed`; not null default `none` |
| reply_attempts | int | not null default 0 |
| reply_sent_at | timestamptz | null |

Indexes: `ix_intake_messages_sender_received (sender_address, received_at)` for the per-sender hourly limit;
`ix_intake_messages_received_at` for the log and pruning; `ix_intake_messages_reply_pending (handled_at) WHERE reply_status = 'pending'`.

Constraints (CHECK), so the database refuses what the privacy rules forbid:
- `sender_address` and `sender_label` are both set or both null.
- No address when the outcome is `unknown_sender` or `sender_not_verified` (AC-12, R-4).
- `reply_status` other than `none` needs a stored address (AC-15): set the address before marking a reply pending.
- `reply_sent_at` only when `reply_status = 'sent'`.
- `file_count`, `files_skipped`, `reply_attempts` are not negative.

## `intake_files`

One row per attachment that was looked at (non-PDFs included, so the reply can list them).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| message_id | uuid FK `intake_messages.id` ON DELETE CASCADE | not null (indexed through the unique `(message_id, position)`) |
| position | int | not null. 1-based order in the email; the reply says "Attachment 2" |
| outcome | enum `intake_file_outcome` | `loaded`, `needs_report_type`, `held`, `released`, `held_deleted`, `refused`, `duplicate` |
| reason_code | varchar(40) | null. One of: `not_pdf`, `too_large`, `unsafe_pdf`, `not_service_report`, `unsure`, `no_text`, `already_on_file`, `over_limit` |
| size_bytes | int | not null |
| page_count | int | null |
| content_sha256 | varchar(64) | null, CHECK 64 lower-case hex characters (same type as `attachments.content_sha256`) |
| report_id | uuid FK `reports.id` ON DELETE SET NULL | null, indexed |
| held_path | varchar | null. Path relative to the storage root (`email-held/<uuid>.pdf`), set only while held |
| read_state | enum `intake_read_state` (`queued`, `waiting_for_limit`, `needs_person`) | null for files that made no report |
| waiting_kind | existing enum `extraction_job_kind` (`create_type=False`) | null. Which job waits for the limit |
| decided_at | timestamptz | null. When an admin released or deleted a held file |
| created_at | timestamptz | server default now() |

Constraint: unique `uq_intake_files_message_position (message_id, position)`; it also serves lookups by `message_id`, so
there is no separate index. Partial indexes: `ix_intake_files_held (created_at) WHERE outcome = 'held'` (held list, oldest
first); `ix_intake_files_waiting_for_limit (created_at) WHERE read_state = 'waiting_for_limit'`. Index on `report_id`.

Constraints (CHECK): `position >= 1`; `size_bytes >= 0`; `page_count` null or not negative; `held_path` only while
`outcome = 'held'` (release and delete must clear it in the same update); `waiting_kind` only while
`read_state = 'waiting_for_limit'` (clear it when the job is queued).
No original attachment name is stored anywhere (AC-24). The attachment row of an emailed report gets a generated
`original_filename` (`emailed-report-<n>.pdf`).

## `report_sources`

| Column | Type | Notes |
|---|---|---|
| report_id | uuid PK, FK `reports.id` ON DELETE CASCADE | one source per report |
| channel | enum `report_source_channel` (`email`, `web`) | not null. Only `email` rows are written now; no row means a web upload. `web` is in the enum so AC-31 needs no enum migration |
| sender_address | varchar(254) | null |
| sender_label | varchar(60) | null |
| received_at | timestamptz | not null |
| intake_file_id | uuid FK `intake_files.id` ON DELETE SET NULL | null, indexed (pruning sets it to NULL) |

Constraint (CHECK): a `channel = 'email'` row has both `sender_address` and `sender_label`.

`Report.source`: `relationship(uselist=False, back_populates="report", cascade="all, delete-orphan", passive_deletes=True, lazy="selectin")`,
so deleting a report through the ORM (`DELETE /reports/{id}`) removes its source row and the reports list loads sources without N+1 queries.
Deleting a report leaves its `intake_files` row and the database sets `intake_files.report_id` to NULL.

## Notes for tests

- `tests/conftest.py` truncates a fixed list of tables. `TRUNCATE reports ... CASCADE` empties `report_sources` and
  `intake_files`, but `intake_messages` and `intake_allow_entries` are not in the list, so their rows survive between
  tests until the list gains them (requested in SL-61's hand-off).

## What is never stored

Email body, subject, attachment names, Reply-To, other recipients, raw headers, the raw Message-ID, and the address of a sender who is
not on the allow list. Refused files are never written to disk. Raw messages are deleted from the mailbox after their row commits (R-9).

## Retention

- `intake_messages` older than `EMAIL_LOG_RETENTION_DAYS` (default 90) are pruned by the worker, with their `intake_files`
  (cascade), except a message that still has a `held` file.
- `report_sources` are not pruned (they belong to the report).
- Held PDFs live until an admin releases or deletes them.
