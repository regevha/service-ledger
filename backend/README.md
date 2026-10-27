# ServiceLedger — backend scaffold

A working implementation of the API surface described in **SL-ARCH-001 §9**
(the ServiceLedger architecture spec, v0.15) — real FastAPI, real
Postgres with JSONB templates, real Alembic migrations, a real background
worker, real tests, and a real React frontend (`frontend/`, not covered by
this README — see its own scripts). `classify()` and `extract()` can run
against the real Claude API (see "Swapping in the real Claude API" below) or
against a deterministic stub; the test suite always forces the stub (see
`tests/conftest.py`) so it never spends a real API call or depends on a
developer's local `.env`.

Read SL-ARCH-001 (the published architecture spec) and its companion
SL-TDD-001 (the technical design document — modules, request lifecycles, API
surface, all at commit-level accuracy) first if you haven't — this scaffold
makes no design decisions of its own; it implements what's already there,
section by section, and every non-obvious choice in the code points back to
the section that justifies it. This README is the quickest way to run it;
SL-TDD-001 is the fuller reference if you're changing it.

## Docker image

`backend/Dockerfile` builds one image for all the jobs. The build context is the **repository root**, and the frontend is built first so the image can carry it:

```
(cd frontend && npm ci && VITE_API_BASE_URL= npm run build)     # empty value = same address as the API
docker build -f backend/Dockerfile -t service-ledger .
docker run --rm -e DATABASE_URL=... service-ledger alembic upgrade head      # create or update the tables
docker run -d -p 8000:8000 -e DATABASE_URL=... -e SHARED_PASSWORD=... -v <folder>:/data service-ledger   # the API and the page (default command)
docker run -d -e DATABASE_URL=... -v <folder>:/data service-ledger python -m app.worker   # the worker
```

Settings come from environment variables only: `DATABASE_URL`, `ATTACHMENT_STORAGE_DIR` (default `/data/attachments`), `USE_LIVE_CLAUDE`, `ANTHROPIC_API_KEY`, and:

- `SHARED_PASSWORD`: one password in front of everything (HTTP Basic, any user name; at least 12 characters or the app refuses to start; empty means no password, as in development). `/health` stays open. It keeps strangers out; it does not identify people, and there is no lockout, so use a long one. Wrong attempts are logged.
- `FRONTEND_DIST_DIR`: the folder with the built page. The image sets it to `/app/web`; the API then serves the page at `/` (API routes win over files of the same name) and refuses to start if the folder has no `index.html`. Unset in development, where the Vite server serves the page.

Mount a folder at `/data` so uploaded files survive a restart; the API and the worker must share it. The process runs as user id 10001, so the mounted folder must be writable by it. The base image can be changed with `--build-arg BASE_IMAGE=...` (default `python:3.11-slim`, the version the CI uses). `requirements.txt` also lists the test tools, so the image carries them; splitting them out is a later tidy-up.

## Troubleshooting: the trace log and the Claude debug log

**Trace log (always on).** The API and the worker write one line per event to the console (UTC, with a trailing `Z`), in the form `time level role [req=<request id> job=<job id>] logger: message`. Every response carries an `X-Request-ID` header (a caller may send its own, 64 safe characters at most); a 500 shows "(reference <id>)" so a tester can quote it. Each request logs `METHOD /path -> status in N ms` (never the query string); `/health` and successful job-status polls are debug level. Queueing a job logs `Queued <kind> job <id> for attachment <id>` under the request's id, and the worker logs `Job <id> started` and `Job <id> finished: <outcome> in <s>` with the job id on every line in between, including the Claude call line. `LOG_LEVEL` (default INFO) sets the level. See `claude/sample-trace-and-debug-log.md` in the project for a real example.

**Claude debug log (off by default).** Set `DEBUG_CLAUDE_LOG=light` (or `deep`) in the environment of the API and the worker, and every Claude call (classify, extract, translate) is recorded as one JSON line in `<attachments folder>/../debug-claude/claude-calls-YYYY-MM-DD.jsonl` (`DEBUG_CLAUDE_LOG_DIR` overrides; in the container that is `/data/debug-claude`, shared by both processes). `light` holds the ids, timing, a description of each document (type, size, SHA-256, never the bytes), the raw answer, token usage and the Anthropic request id; `deep` adds the prompt text and the tool schema. The configured API key is removed from everything written. Files are private to the owner, files older than `DEBUG_CLAUDE_LOG_DAYS` (default 7) are deleted, a failure to log never fails a call, and there is no switch or endpoint in the app: only whoever runs the deployment can turn it on. It holds service-report data, so treat the folder like the database and switch it off afterwards. Read it with:

```
python -m app.tools.show_claude_log [--report ID] [--job ID] [--attachment ID] [--kind classify|extract|translate] [--errors] [--days N] [--last N] [--raw]
python -m app.tools.list_instrument_models      # read-only: the model records, their unit counts, and names that may be the same model
```

## What's here

```
backend/
  app/
    main.py               FastAPI app, router wiring, dev-seed on startup
    config.py              Settings (DB URL, confidence thresholds, worker poll interval, live-Claude switch)
    db.py                   SQLAlchemy engine/session
    models.py               §5 data model, field-for-field (extraction_jobs now one row per stage — kind + error_message)
    schemas.py               Pydantic request/response shapes
    worker.py                §3's background worker — the only caller of classify()/extract(); claims jobs with
                              SELECT ... FOR UPDATE SKIP LOCKED, recovers jobs orphaned by a worker crash
    seed_instruments.py      The fixed fleet (§1): three BD instruments, a Cytek Aurora and a CytoFLEX S
    seed_templates.py        The report_templates rows (§5), plus three model-specific rows for the Cytek Aurora and CytoFLEX S
    seed_demo_reports.py     3 real finalized demo reports for the Reports screen — optional, manual only
    seed_trend_demo.py       5 synthetic PM reports for the FACSAria III, for the trend chart — optional, manual only
    routers/
      instrument_models.py  GET/POST /instrument-models, PATCH/DELETE /instrument-models/{id}, POST .../{id}/merge — models as records: the record is the source (a rename updates its instruments and the templates written for the name, a manufacturer change updates its instruments); delete only with no instruments; merge only same type and moves instruments and templates, refusing on a template clash; an instrument cannot join a model of another type
      instrument_types.py    GET/POST /instrument-types — the managed list of kinds of instrument (the baseline migration). Seeded: Flow cytometer (`facs`), Electron microscope, ImageStream, Mass spectrometer, PCR machine (`ensure_default_types`, run by the seeds and at startup; never renames or removes a type); more are added in the app
      instruments.py         POST/GET/PATCH/DELETE /instruments (DELETE also deletes the instrument's reports; PATCH backs the Instruments tab's create/edit UI —
                              every field but instrument_type is editable); `name`, `model`, `serial_number` and `manufacturer` are required text on create and may not be blank or all whitespace on create or PATCH (422 "<Field> cannot be blank"; values are trimmed); an optional free-text `distributor` (the local seller / service company when it is not the maker; trimmed, blank means none, editable and clearable; the baseline migration); on PATCH a manufacturer can still be cleared (the seeded fleet is "BD", filled in on existing rows only where empty; the baseline migration); `instrument_type` must be a key from /instrument-types, GET /instruments/{id}/trend-fields
                              (which numeric fields a given instrument's own finalized reports actually have
                              data for), GET .../trend (number and number[detector]/number[laser] both
                              supported — TrendOut/TrendPointOut)
      report_templates.py    GET /report-templates (resolution logic, §2); GET .../usage (reports per template, for the manager's warnings); GET .../all, GET/POST/PATCH/DELETE
                              .../{id} — the structured field editor's CRUD, backed by a DB-level unique
                              index on (instrument_type, report_type, model) (the baseline migration)
      reports.py              /reports CRUD (incl. delete), filtered list with free-text search (`q`), export, template confirm, finalize, GET .../{id}/pdf
      saved_filters.py        GET/POST/DELETE /saved-report-filters — a global list of at most five named
                              combinations of the Reports list's six filters (the baseline migration); the
                              client applies one through the ordinary GET /reports
      attachments.py          upload, GET .../file, GET .../pages and .../pages/{n} (a stored PDF's page count, and one page as a PNG `width` pixels wide, rendered with `pypdfium2`; an image scan is one page returned as stored; the phone's Fields | Scan view uses them because Android Chrome cannot show a PDF in an iframe), classify, extract (both 202 + enqueue), extraction-jobs
      translations.py         Hebrew translation (the baseline migration, proposal `claude/proposal-hebrew-translation.md`): `POST /attachments/{id}/translate` (202, enqueues a `translate` job; body `include_pages` asks for pages skipped as QC printouts to be included; sending it again translates again and keeps the earlier one as history), `GET /attachments/{id}/translation` (current) and `/translations` (history), `POST /translations/{id}/accept` (optional edited `accepted_text`; both texts are kept) and `/discard`. A review is always required: classify and extract answer 409 while a translation is being made or waits for review, and for a Hebrew text layer that was never translated; once accepted they read the accepted English instead of the original; a discarded translation means the original is used as before. Instrument QC printout pages are ignored (listed in `ignored_pages`). The English text is for the screen only: no route serves it as a file. No API key: a Hebrew text layer is refused with a message; in stub mode only a file whose name contains "hebrew" gets a fixed fixture. Classification of another company's form also returns `issuer`, `detected_manufacturer`, `maker_in_fleet` (false when the instrument is not in the fleet: the guess is then a zero-confidence placeholder) and `report_type_note` (a second report type); `issuer` and `report_type_note` are stored on the report.
      analytics.py             GET /analytics/fleet — fleet-wide roll-ups (parts, labor hours, pass/fail);
                              GET /analytics/models and /analytics/models/trend — units of one model side by side
    services/
      templates.py            Model-specific-row-over-NULL-row resolution (§2)
      instrument_models.py   Keeps `instruments.model_id` pointing at the `instrument_models` record named exactly like the instrument's model text (a before_flush listener, so the API, seeds and tests all get it); `near_duplicates` only reports look-alike names, nothing is ever merged (the baseline migration; nothing reads the table yet)
      report_search.py        Free-text search: what is indexed (text fields, table text cells, instrument model and serial),
                              the websearch query, excerpts; a before_flush listener keeps reports.search_text current
                              (the baseline migration, partial GIN index on finalized reports)
      classification.py       classify() — live Claude call or stub, by settings.use_live_claude
      extraction.py            extract() — live Claude call or stub, by settings.use_live_claude
      text_reader.py           Reads a PDF's own text layer (model, serial, task code, work order) — no API key
      duplicates.py            Same file bytes / same work-order number already on file (warn; same bytes as an already-read report is refused); also feeds GET /reports/{id}/duplicates
      errors.py                ClassificationError/ExtractionError — what the worker catches per-job
      analytics.py             Pure aggregation for GET /analytics/fleet — computed from already-finalized
                                reports' extracted_fields, no new columns/tables
      pdf_report.py            Renders GET /reports/{id}/pdf — walks the resolved template's field_schema the
                                same way the review screen does, so the PDF never drifts from what's on screen
    testing/reset_db.py       One-shot DB reset used between Playwright e2e runs; not imported by the app
  scripts/export_openapi.py  Dumps app.openapi() to stdout — feeds frontend's `npm run codegen`
                              (see frontend/README.md's "Regenerating API types from the backend")
  alembic/                    Migrations (autogenerated from app/models.py). `0001_baseline` is the whole schema as of 2026-10-26: the 16 earlier migrations were joined into it before any real database existed. A database made by the old chain has a version that no longer exists: recreate it, or run `alembic stamp 0001_baseline` if its schema is already current. Add one migration per change from here.
  tests/                      real Postgres (tests/conftest.py) — see "Testing", below
  storage/attachments/         Local disk storage for scanned originals (§8: dev choice, swap for S3-compatible later)

frontend/
  src/App.tsx                 The real app: document-first intake, report search, report review/finalize
  src/api.ts                   Fetch wrappers for every route above
  src/components/AnalyticsScreen.tsx  The Analytics tab — renders GET /analytics/fleet as stat tiles + bar charts,
                              then ModelComparison.tsx (same-model units: table + one-line-per-unit trend chart)
  src/components/TemplateManager.tsx  The Templates tab — structured field-schema editor + template list/CRUD
  src/components/InstrumentManager.tsx  The Instruments tab — create/edit UI for the fleet (POST/PATCH /instruments)
  tests/e2e/                   Playwright specs against a running backend
```

## Running it

Requires Postgres reachable at the URL in `.env` (copy `.env.example` — the
default matches a local `service_ledger` database/role created for you
already in this environment; adjust for yours).

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# apply migrations
alembic upgrade head

# seed the instrument fleet + report templates (idempotent — also runs
# automatically on server startup, this is just for running it standalone)
python -m app.seed_instruments
python -m app.seed_templates

# optional — 3 more finalized reports (real live-Claude extraction results,
# hardcoded so this is free/offline) so the Reports screen has more than one
# document to show. NOT auto-run on startup, unlike the two seeds above —
# see the module docstring for why (it would pollute the test/e2e databases).
python -m app.seed_demo_reports

# optional — 5 synthetic preventive-maintenance reports for the FACSAria III,
# spaced two months apart, so the instrument detail page's trend chart has a
# real multi-point line (labor_hours) instead of the single-report fallback. Also NOT auto-run,
# same reason as seed_demo_reports above.
python -m app.seed_trend_demo

uvicorn app.main:app --reload
# → http://127.0.0.1:8000/docs for interactive OpenAPI docs

# in a second terminal — §3's background worker. Without this running,
# POST /attachments/{id}/classify and .../extract enqueue a job and return
# 202 immediately, but nothing ever picks it up: reports stay stuck in
# "draft"/"classified" forever.
python -m app.worker
```

Run the tests (against a separate `service_ledger_test` database — see
`tests/conftest.py`; `USE_LIVE_CLAUDE` force-set to
`false` for the whole run):

```bash
pytest
```

Locally the order is random on every run (`pytest-randomly`; the seed is on the
first line of the output). In CI, pushes and pull requests use the fixed order
(`-p no:randomly`) and a scheduled run once a day shuffles it and prints the
seed. Replay a failing order with `pytest -p randomly --randomly-seed=<seed>`;
turn shuffling off with `pytest -p no:randomly`.

Coverage (settings and the reasons for the three omitted dev scripts are in
`.coveragerc`; the run fails below the `fail_under` floor, currently 95%, and
CI runs `pytest --cov`, so a coverage drop fails the build):

```bash
pytest --cov
```

`tests/test_race_conditions.py` covers the `except IntegrityError` branches and
the worker's re-checks: each test commits a competing write between a route's
check and its own commit, so the database's real unique index or foreign key
rejects the request.
The frontend has its own suite — Playwright spec files against a
running backend — run from `frontend/` (see its `package.json`).

## The document-first flow, live

This is the exact sequence the new-report-demo.html artifact simulates,
now backed by a real API:

1. `POST /reports` — bare draft, no instrument or template yet.
2. `POST /reports/{id}/attachments` — upload the scan (multipart file).
3. `POST /attachments/{id}/classify` — enqueues a classify job and returns
   it immediately (`202`, `status: "pending"`) — §3's background worker
   (`python -m app.worker`, see above) is what actually calls
   `classify()`. Poll `GET /extraction-jobs/{id}` until `status` leaves
   `pending`/`classifying`. Both guesses confident (≥
   `CLASSIFICATION_CONFIDENCE_THRESHOLD`, default 0.85) → the report is
   auto-resolved to `classified` with `instrument_id` / `template_id` set.
   Either guess below threshold → the report stays `draft` and step 4 is
   required. Classification also reads the instrument's **serial number** as
   printed on the document and matches it (ignoring case, spaces and
   punctuation) against the fleet: when it matches exactly one instrument,
   read at ≥ the same threshold and agreeing with the model, that instrument
   is used — which is what lets a fleet with several units of one model
   auto-resolve. With no serial (or one not in the fleet) the model alone
   decides as before, so several same-model units still need step 4. A serial
   that belongs to an instrument of a *different* model than the one read
   (`serial_match: "model_conflict"`) is never auto-resolved. The job's
   `classification` carries `instrument_serial`, `serial_match`
   (`matched` / `not_found` / `model_conflict` / `not_read`) and
   `suggested_instrument_id` (pre-selected on the confirm screen). In stub
   mode the "reader" finds a serial when the uploaded file's name contains a
   fleet serial (e.g. `scan_P648282B3003.pdf`).
4. `PATCH /reports/{id}/template` — manual confirm/override (always
   available, not just for the low-confidence case — this is also how an
   incorrect confident guess gets corrected, discarding any prior
   extraction per §4/§6). Synchronous — nothing here calls Claude.
5. `POST /attachments/{id}/extract` — same enqueue-and-poll shape as step 3:
   returns a pending job immediately; the worker runs `extract()` against
   the resolved template and the report moves to `extracted` once the
   polled job reaches `succeeded`.
6. `PATCH /reports/{id}/fields` — lab manager corrections; moves to
   `in_review`. Synchronous.
7. `POST /reports/{id}/finalize` — moves to `finalized`. Synchronous.
8. `DELETE /reports/{id}` — permanently removes the report, its attachments,
   their extraction jobs and the stored scan files (204). A finalized report
   needs `?force=true` (otherwise 409); a report whose scan is still pending
   or being read is also 409. No undo, no audit trail.
9. `DELETE /instruments/{id}` — permanently removes the instrument **and every
   report on it** (drafts and finalized, whatever the instrument's status),
   with their attachments, extraction jobs and scan files (204). The only
   refusal is 409 while one of those reports has a scan still pending or being
   read. No undo, no audit trail; the Instruments tab counts the reports and
   asks first. To keep an instrument's history instead, set it to Retired.

The stub's `classify()` special-cases any filename containing
`WO-04587090`, `sample`, or `work_order`/`work-order` to reproduce the real
BD Care EU Work Order Service Report's actual asymmetry from spec §4:
instrument confidence lands at 0.96, report-type confidence at 0.58 — below
threshold, forcing the manual-fallback branch — and `extract()` returns that
same document's real field values (already used in `repair-review-demo.html`)
when it recognizes that file. Any other filename gets a deterministic
"confident on both" result so the straight-through branch is just as easy to
exercise. `tests/test_document_first_flow.py` walks both branches.

**With no API key, a real document is read, not simulated.** Before falling
back to the stub answer above, `classify()` parses the PDF's own text
(`app/services/text_reader.py`, using `pypdf`): the instrument model from the
"Installed Product" line, the serial number, the Work Order Task Code (which
decides the report type by lookup: T113 repair, T111 preventive maintenance,
T107 installation / upgrade) and the work-order number. A text PDF or fillable
form is classified and resolved this way with no network and no model; the
result says `reader: "text_layer"` (Claude's own reads say `"model"`, the demo
answer `"stub"`). An unknown task code or a model outside the fleet is given
confidence 0, so it goes to the manual pick instead of a guess. It identifies
the document only: reading the template's fields (what was done, parts, labor,
the visit date) still needs Claude, and a scanned image has no text to read.

The same reader runs on every upload to take the work-order number, so a visit
scanned twice is flagged as a probable duplicate straight away (same file bytes
or same work order), with or without a key. One case is refused rather than
flagged: the exact same file bytes as a report that was already read
(extracted, in review or finalized). `POST /reports/{id}/attachments` answers
409 with `{detail, existing_report_id}`, stores nothing and makes no model
calls; the intake screen then offers to open that report and removes the empty
draft it had created. A report that was never read (draft, classified only,
failed) does not count, and deleting the existing report lets the file be
loaded again.

The flag is also kept on the saved report. `GET /reports/{id}/duplicates`
lists the *other* saved reports that probably record the same visit — the same
scan file (on any instrument), or the same normalized work-order number on the
same instrument — each as a report list item plus `reason`
(`same_file` | `same_work_order`) and `work_order_number`. It is computed on
every call, so it follows edits and deletions: delete one copy and the other's
flag disappears. The same work order on a different instrument, or on a draft
with no instrument yet, is not flagged. The report detail screen shows it as a
"Possible duplicate" banner with an "Open that report" button.

To see what it makes of your own files, with no database or
server:

    python -m scripts.read_report scan1.pdf scan2.pdf

## Managing report templates

`app/seed_templates.py`'s hardcoded Python literals were, until now, the
only way to change what a report type's review screen asks for — editing a
field list meant editing that file and re-running the script. The frontend's
Templates tab (`frontend/src/components/TemplateManager.tsx`) and the CRUD
half of `app/routers/report_templates.py` (`GET .../all`, `GET`, `POST`,
`PATCH`, `DELETE .../{id}`) are a real alternative: a structured editor —
add/remove/reorder fields, a per-field-type dropdown, conditional inputs for
an enum's `options` or an `object[]` field's `item_schema` columns — instead
of a raw JSON textarea, since the whole shape it edits is exactly what
`frontend/src/components/FieldEditor.tsx` already knows how to render.
`seed_templates.py` still owns the four templates this scaffold ships with
(and is still what `app.main`'s startup lifespan reseeds from on a fresh
database); the new endpoints are for changing rows after that, including
ones seed_templates.py never created.

`app/schemas.py`'s `TemplateFieldIn` enforces, at the API boundary, exactly
what the review screen can render: `options` is required (and non-empty) for
`enum`/`enum[]` fields and forbidden otherwise, `item_schema` is required
(and non-empty, leaf-typed, no duplicate column names) for `object[]` fields
and forbidden otherwise, and field names must be unique within one template.
`item_schema` is a *list* of `{name, type}` columns (`ItemSchemaColumn`), not
a `{name: type}` dict — Postgres's JSONB storage doesn't preserve an
object's key order (it reorders by key length then lexicographically on the
binary encoding), only a JSON array's element order, so a dict-shaped
`item_schema` silently scrambled a template author's column order on every
read. `TemplateFieldType`
mirrors `frontend/src/api.ts`'s `FieldType` union exactly — the "one
hand-typed enum gap" `frontend/README.md`'s codegen section used to call
out — now closed the same way the other five shared enums are: `FieldType`
is derived from this backend enum via `npm run codegen`, not hand-typed.

`(instrument_type, report_type, model)` uniqueness — previously enforced
only procedurally, by `seed_templates.py`'s own existence-check before
inserting a row — is now backed by a real database constraint too
(`alembic/versions/0001_baseline.py`, mirrored in `models.py`'s
`ReportTemplate.__table_args__` so `Base.metadata.create_all` — what the
test and e2e databases build their schema from — enforces it as well): a
`CREATE UNIQUE INDEX ... (instrument_type, report_type, COALESCE(model,
''))` rather than a plain unique constraint, since Postgres treats every
`NULL` as distinct in an ordinary unique constraint and would otherwise let
two "applies to every model" fallback rows coexist for the same
`(instrument_type, report_type)` — exactly the ambiguity
`services/templates.py::resolve_template()`'s model-fallback logic can't
tolerate. `routers/report_templates.py` still runs its own app-level
pre-check first (a clean `409` for the common case); the DB index is what
closes the race window between two concurrent writes.

Deleting a template that a `Report` still references would otherwise raise
a raw `IntegrityError` — `reports.template_id`'s foreign key has no
`ondelete` (defaults to `RESTRICT`) — so `DELETE /report-templates/{id}`
counts referencing reports first and returns a clean `409` instead.
`tests/test_report_templates.py` covers all of this: the validation rules,
both the app-level and DB-level uniqueness checks, `PATCH`'s
`exclude_unset` semantics (including the same explicit-null-rejection
precedent as `ReportFieldsUpdate`), and the delete guard.

## Swapping in the real Claude API

Everything routes through two functions:

- `app/services/classification.py::classify(db, attachment)` →
  `ClassificationResult`
- `app/services/extraction.py::extract(attachment, template)` →
  `(extracted_fields, field_confidences)`

Both now have a real Claude path (`_live_classify` / `_live_extract`),
selected at runtime by `settings.use_live_claude` — nothing outside these two
files needed to change to add it, exactly as this section originally
predicted. To go live: set `ANTHROPIC_API_KEY` and `USE_LIVE_CLAUDE=true` in
`.env` (never committed — see `.env.example`). The worker (`app/worker.py`,
the only caller of these two functions since §3's async rework), the
router, the tests, and the frontend don't know the difference.

The live path sends the attachment's PDF as a native `document` content
block (Claude's PDF support handles multi-page scans directly, no
per-page image splitting needed) plus, for `extract`, the resolved
template's `field_schema["fields"]` list turned into a JSON tool schema
built on the fly (`extraction.py::_build_extract_tool`). Both calls force
tool use (`tool_choice={"type": "tool", ...}`) so the answer comes back as
validated-shape JSON rather than free text to parse.

Two things worth knowing if you touch this code:

- **The extraction tool schema is deliberately flat** — top-level
  `<field_name>` / `<field_name>__confidence` properties, not a nested
  `{value, confidence}` object per field. A live validation run showed the
  model reliably fills in flat, directly-typed top-level properties (the
  same shape `classify()`'s tool already used successfully) but would
  collapse a nested per-field object into a stringified value and drop
  confidence — tool-use input isn't strictly validated against the schema,
  and this was a real, repeatable weak spot for a schema this shape. There's
  also a defensive unwrap (`_resolve_extraction_data`, plus a per-field
  check in `_live_extract`) for the rarer case where the model still wraps
  its whole answer, or one field's answer, in an extra key anyway.
- **The privacy prompt is not just the product-spec wording.** Beyond
  keeping customer contact/billing/contract details out of field values
  (§4/§10), a live run against the real FACSAria III repair document showed
  the technician's own sign-off ("... . By Shachar on 18/04/2021", a
  pattern this fleet's quote logs use) leaking into `fault_description` —
  the same class of gap already caught once by hand in the demo HTML pages,
  now caught again by an actual API call and fixed by naming that pattern
  explicitly in `_EXTRACT_PROMPT_HEADER`. Anyone extending this prompt
  should assume more such gaps exist until they're demonstrated against
  real documents, not asserted from the spec text alone.

### Failure handling

Going live means the pipeline now depends on a network call that can fail
in ways the stub never did — a bad key, a dropped connection, a timeout, a
rate limit, or (seen in practice above) a response that doesn't match the
expected shape. `_live_classify`/`_live_extract` catch all of these and
raise `ClassificationError`/`ExtractionError` (`app/services/errors.py`)
with a message meant for a human, not a stack trace. The Anthropic client is
built with an explicit `timeout` and `max_retries`
(`ANTHROPIC_TIMEOUT_SECONDS` / `ANTHROPIC_MAX_RETRIES` in `.env` — the SDK
already retries connection errors/408/409/429/5xx internally with backoff,
this just makes the budget explicit instead of trusting an undocumented
default).

Uploads are checked before anything is written (`POST /reports/{id}/attachments`):
only a PDF or a PNG, JPEG, GIF or WebP image is accepted, decided from the
file's own leading bytes rather than the client's content type (415 otherwise;
422 for an empty file; 413 over `MAX_PDF_UPLOAD_BYTES` / `MAX_IMAGE_UPLOAD_BYTES`).
`app/services/documents.py` then sends a PDF to Claude as a `document` block
and a picture as an `image` block. The page count of a PDF is not checked, so a
document over the API's page limit fails as an ordinary job error.

The routers (`app/routers/attachments.py`) catch both error types: instead
of a bare 500 with no trace of what was attempted, `classify`/`extract`
return `502` with the error message, and — this is the part that actually
matters for a technician looking at a stuck report later — write an
`ExtractionJob` row with `status=failed` and `error_message` set
(`extraction_jobs.error_message`, added in the
`add_error_message_to_extraction_jobs` migration) so the failure has a
record, not just an error response nobody saw. `tests/test_live_claude_failures.py`
covers both paths by monkeypatching `classify`/`extract` to raise — the
suite doesn't and shouldn't call the real API (see `tests/conftest.py`).

One schema path — `number[detector]`/`number[laser]` — was only ever used by
the `calibration` templates, which have since been removed (lab users asked
for the report type to go). The field types are still available to custom
templates, and `tests/test_extraction_schema.py` still proves the JSON-schema
construction for them doesn't break, but no seeded template uses them and
they have never been checked against a real document.

### Confirming the live path actually ran

`USE_LIVE_CLAUDE=true` in `.env` is easy to set and easy to be wrong about —
a stale env var, a cached `Settings` object, or a test harness that force-sets
`USE_LIVE_CLAUDE=false` (Playwright's `playwright.config.ts` does exactly
this, deliberately, to stay deterministic) can silently leave you looking at
stub output while believing it's live. None of these are hypothetical —
`playwright.config.ts`'s webServer commands literally hardcode
`USE_LIVE_CLAUDE=false` regardless of `.env`, since env vars set in the shell
take priority over `.env` file values (pydantic-settings' default). Checking
`settings.use_live_claude` alone only proves the switch was read, not that
`_live_classify`/`_live_extract` actually executed and got a real answer
back. What actually proves it, in increasing order of certainty:

1. **The transport-level log line.** `_get_client()` returns a real
   `anthropic.Anthropic` client whose underlying `httpx` transport logs every
   outbound request at INFO level: `HTTP Request: POST
   https://api.anthropic.com/v1/messages "HTTP/1.1 200 OK"`. The stub path
   never constructs this client or calls `.messages.create()` at all, so this
   line cannot appear unless the live path ran — set
   `logging.basicConfig(level=logging.INFO)` (or run via `app/worker.py`,
   which already does this) to see it.
2. **Non-null token usage in the call-timing log.** Both `_live_classify` and
   `_live_extract` log one line per call —
   `Claude classify/extract API call for attachment <path> completed in
   <N>s (input_tokens=<N>, output_tokens=<N>)` — reading `input_tokens`/
   `output_tokens` off the real `anthropic.types.Message.usage` object. A
   stub response is a plain Python object with no `.usage` attribute, so this
   degrades to `input_tokens=?, output_tokens=?` under stub (see
   `tests/test_live_claude_parsing.py`'s fakes, which never set `.usage`
   either) — real integers here mean a real `Message` came back.
3. **The decisive test: diff against what the stub would have said for the
   same file.** `_stub_classify`/`_stub_extract` are pure functions of the
   attachment's file path — call them directly (no API, no cost) on the same
   file and compare. For the real sample document (any filename containing
   `WO-04587090`/`sample`/`work_order`), the stub *always* returns report-type
   confidence 0.58 (deliberately below the 0.85 threshold, forcing the
   manual-confirm branch — see above) and *always* returns the same two fixed
   sentences for `fault_description`/`work_performed`. A live run against
   that exact file instead auto-resolved at 0.95 confidence and extracted a
   specific pressure reading ("4.95 PSI, changed to 4.5") that exists only in
   the scanned document, not anywhere in this codebase. Getting a different
   *decision* (auto-resolve vs. manual-confirm), not just different wording,
   on a file the stub is hardcoded to always route one way is the strongest
   evidence available that the model actually read the document.

`backend/validate_live.py` and `backend/dump_live_json.py` (both
intentionally uncommitted scratch scripts, not part of the app) run
`classify()`/`extract()` live against six real scanned BD Care Work Order
PDFs for exactly this kind of check — see their docstrings.

## Known gaps against the full spec (intentionally out of scope for this scaffold)

- **No PDF preprocessing, and it turned out not to matter.** `page_count`
  is still hardcoded to 1 — §4 step 2's page-splitting was never built,
  because the live path sends the whole PDF to Claude as a single native
  document upload instead, and Claude's own PDF support reads every page
  directly. Real per-page splitting still has nothing to run against.
- **`source_snippet` isn't modeled, and not just because it's unbuilt.**
  §4/§10's per-field snippet (cropped tightly to avoid pulling in incidental
  contact/contract text) would need the live extraction schema to carry a
  nested `{value, confidence, source_snippet}` object per field — but a live
  validation run showed the model reliably fills in flat, top-level
  properties and collapses/stringifies a nested object like that (see
  "Swapping in the real Claude API" above), which is why the schema is flat
  today. Reintroducing `source_snippet` means solving that schema problem
  first, not just wiring up an existing field.
- **`preventive_maintenance` is now grounded in two real documents, not
  zero** (v0.12) — an LSRFortessa visit and a FACSDiscover S8 visit, neither
  carrying any model-specific field. Only a FACSAria III PM report remains
  unchecked (§12).
- **`repair` is now confirmed across all three instrument models** (v0.12)
  — two LSRFortessa repairs, a FACSAria III repair, and a FACSDiscover S8
  repair all map cleanly with zero schema changes, making it the only
  template checked against every model in scope (§5, §12).
