# ServiceLedger hardening plan (docs/PLAN.md)

Baseline: `main` @ 97be7fc (2026-11-12). Sources: the user's remediation plan (phases 1-4, "closed when" checks), the user's final decisions of 2026-11-12, and the project-manager's status audit, re-checked against the code by the architect.

## Goal

Finish the remediation plan on the existing, mature codebase without redesigning it: close the remaining Phase 2 safety items, make the data/worker layer safe at scale and for a second worker/replica (Phase 3), and replace the shared password with per-user Microsoft Entra ID sign-in with two roles (Phase 4), which is the gate for external ingress.

### Goals
- Every open or partly-done plan step becomes one or more small tasks with testable acceptance criteria taken from the plan's "closed when" checks.
- Migrations are serial and reversible, numbered from 0014, one Alembic head at all times.
- 3.4 (worker owner column + search cap in the database) ships before any second worker or API replica.

### Non-goals
- No redesign, no new features, no tasks beyond the plan. This is a hardening backlog: the "stop at demo-ready" rule does not apply, and nothing here adds a demo step.
- No git-history rewrite. No changes to `docs/live-runs/` content or to the vendor PDFs in `frontend/tests/e2e/fixtures/`. No agent reads real serial or work-order numbers.
- No `pyproject.toml`; `ruff.toml` stays. CI keeps `npx tsc -b`; no switch to `npm run build`.
- External ingress is not opened by this plan. It needs 4.2-4.6 plus a rate limit, then a separate user decision.
- 3.5 (threshold calibration) is not built. It is blocked until 50-100 finalized reports exist.

## Stack and constraints

Existing stack, unchanged:
- Backend: Python 3.11, FastAPI, Pydantic v2, SQLAlchemy 2.0, Alembic, PostgreSQL 16, in `backend/`. Deviation from the team default (3.12, `server/`): this is the existing codebase. CI, the Docker base image and `ruff.toml` all target 3.11.
- Frontend: React + TypeScript + Vite in `frontend/`. Lint with oxlint, type-check with `tsc -b`.
- E2E: Playwright in `frontend/tests/e2e*` (configs `frontend/playwright*.config.ts`).
- Deploy: Azure Container Apps, using the scripts in `deploy/azure/`. One image (`backend/Dockerfile`) runs both the API and the worker.

Constraints (all tasks):
- **One small PR per change.** Each PR comes from its own branch (`phaseN/short-name`, matching the existing branch names). Nobody pushes to `main`. Merges happen only through PRs with green CI.
- **Migrations start at 0014 and are strictly serial.** Each one chains from the current head (today `0013_job_heartbeat`). Two migration PRs open at the same time would create two Alembic heads, so a migration PR is opened only after the previous one is merged. Before each merge, `alembic heads` must show exactly one head.
- Every schema change is a versioned, reversible migration. Destructive steps (dropping a table or column, or data loss) need the user's explicit approval before they run. Agents run migrations only against local or throwaway databases. Applying a migration to a deployed environment is a manual step that needs the user's go-ahead.
- The test database is built with `Base.metadata.create_all` (`backend/tests/conftest.py`). So every index, column and table must be declared on the model as well as in the migration. `alembic check` in CI enforces this. Migrations up/down/up are tested on a fresh database, outside the pytest fixture.

## Conventions

**Area mapping (team roles to this repo):**

| Team area | This repo | Owner |
|---|---|---|
| models + migrations (`server/db/`) | `backend/app/models/`, `backend/alembic/` | db-engineer |
| backend (`server/app/`) | `backend/app/` except models, `backend/requirements.txt`, `backend/.env.example` | backend-dev |
| backend tests (`server/tests/`) | `backend/tests/` | tester |
| frontend (`web/`) | `frontend/src/`, `frontend/package.json`, `frontend/vite.config.ts`, `frontend/.env.example` | frontend-dev |
| frontend tests (`e2e/`) | `frontend/tests/`, `frontend/playwright*.config.ts`, `frontend/src/**/*.test.ts` | e2e-tester |
| CI, Docker, deploy, root files | `.github/`, `backend/Dockerfile`, `deploy/`, root `LICENSE`/`SECURITY.md`, tool configs (`backend/ruff.toml`, `backend/mypy.ini`) | devops |

- **Generated API types:** `frontend/src/generated/api-schema.ts` is generated, never edited by hand. A PR that changes the API runs `cd frontend && npm run codegen` and commits the result, because the CI drift check fails otherwise. This is the only file a backend PR may touch in `frontend/`.
- **Contracts:** the repo has no `docs/API.md` or `docs/DATA_MODEL.md`. The API contract is the FastAPI OpenAPI schema plus the committed `api-schema.ts`. The design reference is `docs/service-ledger-tdd.html`. Any change to a request or response shape, a status code, or a table goes through "Contract change requests" below before code is written.
- **Error precedence (applies to every endpoint once Phase 4 lands; the existing order is unchanged):**
  1. `401`: no or invalid credentials. This is answered by the auth middleware before routing. A malformed body, an unknown path or a bad UUID with no valid session gets 401, never 422 or 404. `/health` is exempt. CORS preflight (`OPTIONS`) passes through to the CORS middleware without credentials.
  2. `403`: authenticated but not allowed: a read-only user on a write endpoint, or a deactivated user. This is raised by a router-level dependency, so it fires before path, query and body validation.
  3. `422`: path, query or body validation (FastAPI), and domain `InvalidError`/`PlaceTextError`.
  4. `404`: entity not found (`NotFoundError`).
  5. `409`: conflict (`ConflictError`, or an unfinished job already exists).
  6. `429`: job limits (`services/job_limits.py`). These are checked after the unfinished-job check, as today.
- **Commit before response:** every write endpoint commits its transaction before it returns the response. Audit/acting-user rows (4.4) are written in the same transaction as the change they describe. No write is deferred to a background task after the response.
- **Backend checks** (from `backend/`): `ruff check .`, `alembic upgrade head && alembic check`, `pytest -q -p no:randomly` (the coverage floor in `backend/.coveragerc` is 95%, so new code ships with its tests in the same PR), and `mypy` after SL-07. The repo uses pip with `requirements.txt`, not uv. Tools that are not runtime dependencies are pinned in the CI step, the way ruff is.
- **Frontend checks** (from `frontend/`): `npx oxlint`, `npx tsc -b`, `npm test` (Vitest, after SL-04), `npx playwright test`.
- **TypeScript:** new code uses the generated types from `api-schema.ts` via `src/api/types.ts`. No `any` in new code. Test files `src/**/*.test.ts` are type-checked by `tsc -b` (`tsconfig.app.json` includes `src`).
- **Ports and databases:** the e2e suite uses backend 8001, Vite 5174 and DB `service_ledger_e2e` (`playwright.config.ts`). Any agent that starts servers uses its own ports, outside 8000/8001/5173/5174, and its own throwaway database (e.g. `service_ledger_sl<nn>`). It drops both when finished.
- **CI:** pin third-party GitHub Actions by commit SHA in every step a task adds or edits. Never weaken or skip an existing check to get green. New workflow-level settings follow `test.yml`'s comment style.
- **New settings (env vars). Names are proposed; the owning task fixes them and adds them to `backend/.env.example`:**
  - `JOB_RETENTION_DAYS` (SL-14)
  - `WORKER_ID`, default hostname + pid (SL-17)
  - `AUTH_MODE` = `shared` (today's behaviour, and the default, so existing tests stay unauthenticated) | `entra` (SL-39)
  - `ENTRA_TENANT_ID`, `ENTRA_API_AUDIENCE` (SL-39)
  - frontend `VITE_ENTRA_CLIENT_ID`, `VITE_ENTRA_TENANT_ID`, `VITE_ENTRA_API_SCOPE` (SL-47)
- **Tokens:** Entra access tokens go in an `Authorization: Bearer` header. No app session cookie (see CCR-04 for downloads). The MSAL token cache lives in `sessionStorage`.
- **Gates beyond tests:** every UI task (SL-25, SL-47, SL-48, SL-53) needs a ux-reviewer brief before the build. A reviewer or ux-reviewer then looks at it in a real browser (Playwright, system Chrome) before it closes. Every task gets a `reviewer` pass.

## Statuses

`todo` -> `in-progress` -> `in-review` (set by the implementing agent when its own checks pass) -> `done` (set **only by the lead**, after test, review and green CI). Any task can be set to `blocked`, with the reason in its row. Agents edit only their own rows.

## Already merged (not tasks)

| Plan step | State | PR |
|---|---|---|
| 1.1 scrub live-runs, synthetic fixtures | Merged in part: raw files removed from the tree, `.gitignore` updated, no history rewrite (user decision). The 3 fixture PDFs were not replaced and not verified; see Open questions. | #273 |
| 1.2 job cap 60/day + 3 retries, DB-counted, 429 | Merged | #270 |
| 1.3 INGRESS internal, documented in `deploy/azure/README.md` | Merged | #272 |
| 1.4 narrow CORS when `FRONTEND_DIST_DIR` set | Merged | #271 |
| 1.5 stub-mode startup warning | Merged | #271 |
| 2.1 CI type-check + lint (`npx tsc -b`, `npx oxlint`), accepted as is | Merged | #274 |
| 2.2 schema drift check (+ `alembic check`) | Merged | #274 |
| 2.3 ruff (`backend/ruff.toml` + CI step), accepted in place of pyproject.toml | Merged (mypy part open: SL-07) | #274 |
| Concurrency group in `test.yml` | Merged (`visual-baselines.yml` open: SL-11) | #274 |
| 3.4 recovery by heartbeat (`0013_job_heartbeat`, stale-only recovery) | Merged (owner column + search cap open: SL-16..SL-21) | #280 |
| 4.1 sign-in method and roles | Decided by user 2026-11-12: Microsoft Entra ID, roles `editor` and `read-only`. The parked proposal-role-based-auth.md is not in the repo, and nothing here relies on it. | n/a |

## Migration ledger

Numbers are reserved in this order. A migration whose task is dropped frees its number, and the next one is renumbered before it opens a PR.

| No. | Revision id (proposed) | Task | Wave |
|---|---|---|---|
| 0014 | `0014_query_indexes` | SL-12 | B |
| 0015 | `0015_job_worker_id` | SL-16 | B |
| 0016 | `0016_search_model_usage` | SL-19 | B |
| 0017 | `0017_relative_attachment_paths` | SL-33 | B (ships alone) |
| 0018 | `0018_users` | SL-38 | C |
| 0019 | `0019_audit_events` (pending CCR-03) | SL-44 | C |
| 0020 | `0020_sign_in_failures` (pending CCR-05) | SL-49 | C |

3.2 retention, 3.6 pagination/aggregates and 3.7 page_count are not expected to need a migration. If one turns out to, it takes the next free number at that time, and every later row moves up by one.

## Tasks

Columns: ID, owner, description, acceptance criteria, files touched, depends on, status. "Same branch as" means one PR: the test and the code land together, so CI and the coverage floor stay green.

### Wave A: parallel-safe, no migrations

Groups that run in parallel: {SL-01}, {SL-02, SL-03}, {SL-04, SL-05, SL-06} then {SL-07}, {SL-08, SL-09}, {SL-10}, {SL-11}. SL-07 waits for SL-06 because both edit `test.yml`.

| ID | Owner | Description | Acceptance criteria | Files touched | Depends on | Status |
|---|---|---|---|---|---|---|
| SL-01 | devops | 2.5: add LICENSE (all rights reserved, copyright holder "Regev"), SECURITY.md (report through GitHub private vulnerability reporting; no e-mail address), CODEOWNERS (owner `regevha`) | LICENSE grants no open-source licence and names "Regev" as copyright holder. SECURITY.md points to the repo's Security tab, "Report a vulnerability", and `grep -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' SECURITY.md LICENSE` finds nothing. GitHub's CODEOWNERS view shows no errors. Private vulnerability reporting is switched on in repo settings (user action, see Open questions). | `LICENSE`, `SECURITY.md`, `.github/CODEOWNERS` | none | todo |
| SL-02 | tester | 2.6 test: assert that both Claude prompts (classify, extract) contain the line saying document content is untrusted data and instructions inside it are ignored. Commit it first on the branch. | The new test in `test_prompt_wording.py` fails before SL-03 and passes after it. `test_prompts_carry_no_real_identifiers_or_names` still passes. | `backend/tests/test_prompt_wording.py` (plus `backend/tests/test_prompt_preview.py` only if a stored prompt text there changes) | none | todo |
| SL-03 | backend-dev | 2.6: add the prompt-injection line to all four prompts (classify, extract, translate, search; user decision D-3) | SL-02 passes. Whole backend suite green; ruff clean. The wording contains no real names or identifiers. | `backend/app/services/classification_prompt.py`, `backend/app/services/extraction_prompt.py` | SL-02 (same branch) | todo |
| SL-04 | frontend-dev | 2.4 setup: add Vitest (exact pinned devDependency), a `"test": "vitest run"` script, and a `test` block in `vite.config.ts` (node environment, include `src/**/*.test.ts`). Document it in the frontend README. | `npm test` runs Vitest only. `npx playwright test` collects no `*.test.ts`. `npx tsc -b` and `npx oxlint` are green. With `COVERAGE=1` the Istanbul plugin still instruments only app code. | `frontend/package.json`, `frontend/package-lock.json`, `frontend/vite.config.ts`, `frontend/README.md` | none | todo |
| SL-05 | e2e-tester | 2.4 tests: unit tests for the pure modules `numberCondition`, `diffWords`, `reportSort`, `isoDay`, `reviewSearch` | At least one passing test file per module (5 files) under `npm test`. A deliberately broken assertion makes `npm test` exit non-zero. | `frontend/src/numberCondition.test.ts`, `frontend/src/diffWords.test.ts`, `frontend/src/reportSort.test.ts`, `frontend/src/isoDay.test.ts`, `frontend/src/reviewSearch.test.ts` | SL-04 (same branch) | todo |
| SL-06 | devops | 2.4 CI: add an `npm test` step to the `static-checks` job after the TypeScript type-check. Pin third-party GitHub Actions by commit SHA. | A PR with a failing Vitest test fails `static-checks`. Green on the SL-04/05 branch. No existing step changed. | `.github/workflows/test.yml` | SL-05 (same branch) | todo |
| SL-07 | devops | 2.3 rest: mypy. Add `backend/mypy.ini` next to `ruff.toml`, with the same header-comment style and `python_version = 3.11`. Add a CI step in `static-checks` that installs a pinned mypy (as ruff is installed, not in requirements.txt), counts the errors, and compares the count with `backend/mypy-baseline.txt`. It fails only if the count rises. A PR that lowers the count also lowers the baseline. Pin third-party GitHub Actions by commit SHA. | On `main` the step is green, with the baseline equal to the current count. A PR adding a new mypy error fails CI. A PR that removes errors passes, and its baseline goes down. No `pyproject.toml`; `ruff.toml` unchanged. The README documents the local command. | `backend/mypy.ini`, `backend/mypy-baseline.txt`, `.github/workflows/test.yml`, `backend/README.md` | SL-06 (both edit `test.yml`) | todo |
| SL-08 | tester | 3.7 Hebrew scrub test: cases with Hebrew role labels followed by a Hebrew name, using **invented** names only (never names from real reports). Also negative cases: Hebrew technical text with no role label. Commit first on the branch. | The new cases fail before SL-09 and pass after it. The negative cases are unchanged by the scrub. | `backend/tests/test_privacy.py` | none | todo |
| SL-09 | backend-dev | 3.7: extend `scrub_text` so Hebrew names are removed (Hebrew has no capitals, so today's `[A-Z]`-based rules miss them). Changed fields are still marked doubtful. | SL-08 passes. `test_privacy.py`, `test_hebrew_translation.py` and `test_seed_hebrew_form_templates.py` stay green. English behaviour unchanged. | `backend/app/services/privacy.py` | SL-08 (same branch) | todo |
| SL-10 | devops | 3.7: Docker `HEALTHCHECK` in `backend/Dockerfile` that probes `/health` with Python's standard library (the slim image has no curl). The worker container from the same image must not be reported unhealthy. | `docker build` succeeds. An API container started from the image reaches `healthy` in `docker inspect`. A container started with `python -m app.worker` is not `unhealthy`. The image size is unchanged apart from the instruction. | `backend/Dockerfile` (plus `deploy/azure/deploy.sh` only if the worker app needs an override; plus `deploy/azure/README.md` for a one-line note) | none | todo |
| SL-11 | devops | Concurrency group in `visual-baselines.yml`: a newer dispatch on the same branch cancels the older run | Two dispatches on one branch: the first is cancelled. Dispatches on two different branches both run. Pin third-party GitHub Actions by commit SHA. | `.github/workflows/visual-baselines.yml` | none | todo |

### Wave B: strictly serial (one PR open at a time, in this order)

Order: 3.1 (SL-12/13) -> 3.2 (SL-14/15) -> 3.4 (SL-16/17/18, then SL-19/20/21) -> 3.7 page_count (SL-22/23) -> 3.6 (SL-24..SL-30) -> 3.3 (SL-31/32, then SL-33/34/35, alone). Within a row pair, the tester and the implementer work on the same branch. The test can be committed first.

| ID | Owner | Description | Acceptance criteria | Files touched | Depends on | Status |
|---|---|---|---|---|---|---|
| SL-12 | db-engineer | 3.1: migration 0014 adds indexes on `reports.instrument_id`, `reports.template_id`, `reports.status`, `reports.report_date`, `attachments.report_id` and `extraction_jobs.attachment_id` (not indexed today; see P-01), plus a partial index on `extraction_jobs(started_at) WHERE status = 'pending'`. Each index is also declared on its model. | `alembic heads` shows one head, `0014_query_indexes`, chained from `0013_job_heartbeat`. `alembic check` is clean. up/down/up works on a fresh DB. Downgrade drops exactly these indexes. The EXPLAIN checks in SL-13 pass. | `backend/alembic/versions/0014_query_indexes.py`, `backend/app/models/reports.py`, `backend/app/models/jobs.py` | Wave A merged (not required; keeps CI noise low) | todo |
| SL-13 | tester | 3.1 check: at 100k jobs / 10k reports (generated synthetic rows), `EXPLAIN` of the report filters, attachments-by-report, jobs-by-attachment and the claim-next-pending query uses index scans. Also run migration up/down/up on a throwaway DB. | "EXPLAIN uses index scans at 100k jobs/10k reports" for each listed query. Migration round trip clean. If the daily-cap count (`started_at` range) still scans, report it (P-14) without changing scope. | `backend/tests/test_query_indexes.py` | SL-12 (same branch) | todo |
| SL-14 | backend-dev | 3.2: retention for finished jobs. A periodic purge in the worker (next to the periodic recovery) deletes `succeeded`/`failed` jobs whose `completed_at` is older than `JOB_RETENTION_DAYS`, in batches. | Finished jobs older than the retention period are deleted. Pending, in-progress and `awaiting_approval` jobs are never deleted. No job inside the job-limit 24 h window is ever deleted: a retention below 2 days is refused at startup. Daily-cap and retry counts are identical before and after a purge. Proposed, pending lead confirmation (P-02): jobs of reports that are not yet finalized are kept. Safe when two workers purge at once. | `backend/app/services/job_retention.py` (new), `backend/app/worker.py`, `backend/app/config.py`, `backend/.env.example` | SL-12 (serial) | todo |
| SL-15 | tester | 3.2 tests | The criteria of SL-14, each as a test, including the limit counts around a purge | `backend/tests/test_job_retention.py` (new) | SL-14 (same branch) | todo |
| SL-16 | db-engineer | 3.4: migration 0015 adds a nullable `extraction_jobs.worker_id` (string), plus the model column. It is named `worker_id`, not `owner`, so it does not clash with 4.4's acting user (P-08). | One head, `0015_job_worker_id`. `alembic check` clean. up/down/up clean. Existing rows get NULL. | `backend/alembic/versions/0015_job_worker_id.py`, `backend/app/models/jobs.py` | SL-14 (serial) | todo |
| SL-17 | backend-dev | 3.4: each worker has an ID (`WORKER_ID`, default hostname + pid). Claiming a job sets `worker_id`. Heartbeat and final-status updates apply only `WHERE worker_id = me`. Recovery at startup and periodically still fails only jobs whose heartbeat is stale or NULL, and logs the dead owner's ID. | "Two workers don't fail each other's running job." A worker whose job was failed by recovery and claimed again cannot refresh or finish it. A job claimed before 0015 (NULL `worker_id`) is still recovered when stale. | `backend/app/job_queue.py`, `backend/app/worker.py`, `backend/app/config.py`, `backend/.env.example` | SL-16 | todo |
| SL-18 | tester | 3.4 tests: two worker IDs against one DB, plus the stale and zombie cases | Criteria of SL-17 covered. `test_worker.py` and `test_race_conditions.py` green. | `backend/tests/test_worker.py`, `backend/tests/test_race_conditions.py` | SL-17 (same branch) | todo |
| SL-19 | db-engineer | 3.4: migration 0016 adds the table `search_model_usage(day date primary key, count integer not null default 0)`, plus its model | One head, `0016_search_model_usage`. `alembic check` clean. up/down/up clean. The model is registered without breaking the deliberate import order in `models/__init__.py`. | `backend/alembic/versions/0016_search_model_usage.py`, `backend/app/models/usage.py` (new), `backend/app/models/__init__.py` | SL-17 (serial) | todo |
| SL-20 | backend-dev | 3.4: move the model-search daily cap from process memory (`_cap_state` + `threading.Lock`) to the database, with one atomic upsert per call (increment only while under `SEARCH_MODEL_DAILY_CAP`). Replace `reset_cap_for_tests` with a DB-based reset. | Two API processes sharing one DB never exceed the cap in total. The count survives a restart. A cap of 0 or less disables the model. A DB error while counting falls back to the rules' answer with no model call. No module-level cap state remains. | `backend/app/services/report_query_model.py` | SL-19 | todo |
| SL-21 | tester | 3.4 search-cap tests, including two concurrent sessions | Criteria of SL-20 covered | `backend/tests/test_report_query_model.py` | SL-20 (same branch) | todo |
| SL-22 | backend-dev | 3.7: real `page_count` at upload. Reuse the pdfium counting already used by `GET /attachments/{id}/pages`, under `PDFIUM_LOCK`. | An uploaded N-page PDF stores `page_count = N`. An image stores 1. An unreadable PDF upload still succeeds, with 1 and a log line (it is not refused at upload). Existing rows unchanged. The `TODO` at the upload site is gone. | `backend/app/routers/attachments.py` | SL-21 (serial) | todo |
| SL-23 | tester | 3.7 page_count tests (synthetic PDFs only) | Criteria of SL-22 covered | `backend/tests/test_attachment_pages.py` | SL-22 (same branch) | todo |
| SL-24 | backend-dev | 3.6: paginate `GET /reports` and stream `GET /reports/export`, as agreed in CCR-01/CCR-02 | As in CCR-01. Export of 10k reports streams without loading all rows into memory (`yield_per`). Search results and the CSV have the same content and order as before on the existing fixtures. `api-schema.ts` regenerated. | `backend/app/routers/reports.py`, `backend/app/schemas/reports.py`, `backend/app/services/report_views.py`, `frontend/src/generated/api-schema.ts` | SL-23 (serial), CCR-01, CCR-02 accepted | todo |
| SL-25 | frontend-dev | 3.6: the report list screen and the other `listReports` callers use the paginated API (CCR-01). Grouping, sorting and status counts stay correct. | No caller silently shows a truncated list. ReportsListScreen pages through results. Status pills and Home counts match the server totals. `tsc -b`, oxlint and the e2e suite green. | `frontend/src/api/reports.ts`, `frontend/src/api/types.ts`, `frontend/src/components/ReportsListScreen.tsx`, `frontend/src/components/reports/useStatusCounts.ts`, `frontend/src/components/reports/ResultsToolbar.tsx`, `frontend/src/components/reports/grouping.ts`, `frontend/src/components/HomeScreen.tsx`, `frontend/src/components/InstrumentDetailScreen.tsx`, `frontend/src/components/InstrumentManager.tsx`, `frontend/src/components/AdminScreen.tsx` | SL-24 (same branch: the shape change and its callers ship together) | todo |
| SL-26 | tester | 3.6 backend tests for pagination and export | Bounds, total, stable order with `q` ranking, export streaming and content unchanged | `backend/tests/test_reports_search_export.py`, `backend/tests/test_report_search.py` | SL-24 (same branch) | todo |
| SL-27 | e2e-tester | 3.6 browser flow: page through more reports than one page; export still has every row | The flow passes in Chromium, phone and desktop projects. The CSV export specs are green. | `frontend/tests/e2e/reports-pagination.spec.ts` (new), `frontend/tests/e2e/csv-export.spec.ts`, `frontend/tests/e2e/csv-export-content.spec.ts` | SL-25 (same branch) | todo |
| SL-28 | backend-dev | 3.6: compute Home summary with SQL aggregates instead of loading rows into Python | Response is identical (same JSON) on the existing fixtures. Home summary for 10k reports in under 2 s. No response-shape change. | `backend/app/services/home_summary.py` | SL-27 (serial) | todo |
| SL-29 | backend-dev | 3.6: compute Analytics with SQL aggregates (fleet, model comparison, trends, values) | "Analytics for 10k reports < 2 s" for each `/analytics/*` endpoint. Responses identical on the existing fixtures. No response-shape change. | `backend/app/services/analytics/fleet.py`, `backend/app/services/analytics/comparison.py`, `backend/app/services/analytics/trends.py`, `backend/app/services/analytics/values.py`, `backend/app/services/analytics/filters.py` | SL-28 (serial) | todo |
| SL-30 | tester | 3.6 equality and timing tests for Home and Analytics at 10k synthetic reports | Old vs new output equal. Timing under 2 s on the CI runner (marked so a slow runner reports rather than flakes). | `backend/tests/test_home_summary.py`, `backend/tests/test_analytics.py`, `backend/tests/test_analytics_scale.py` (new) | SL-28, SL-29 (same branches) | todo |
| SL-31 | backend-dev | 3.3 step 1 (code, backward-compatible): one resolver turns a stored path into a file path. It accepts legacy absolute paths and paths relative to `ATTACHMENT_STORAGE_DIR`, and refuses `..` escapes. New uploads store relative paths. Every reader uses the resolver. | Uploads store a relative path. Legacy absolute rows still open. A stored `../x` is refused. Stub-mode classification results on the e2e fixtures are unchanged (it hashes `file_path`, P-10). All suites green. | `backend/app/services/attachment_storage.py` (new), `backend/app/routers/attachments.py`, `backend/app/worker.py`, `backend/app/services/classification.py`, `backend/app/services/translation.py`, `backend/app/services/report_deletion.py`, `backend/app/seed_demo_reports.py`, `backend/app/seed_trend_demo.py`, `backend/app/config.py` | SL-30 (serial) | todo |
| SL-32 | tester | 3.3 resolver tests | Criteria of SL-31 covered | `backend/tests/test_attachment_file.py`, `backend/tests/test_attachment_storage.py` (new) | SL-31 (same branch) | todo |
| SL-33 | db-engineer | 3.3 step 2, **ships alone**: data migration 0017 rewrites absolute `attachments.file_path` values under the storage dir to relative ones. Rows outside the storage dir stop the migration with a count, so nothing is lost. Downgrade re-prefixes them. | "No `attachments.file_path` starts with `/`" after upgrade. Downgrade restores the absolute values. up/down/up clean on a fresh DB seeded with mixed rows. No other PR merges while this one is open. | `backend/alembic/versions/0017_relative_attachment_paths.py` | SL-31 merged **and deployed**; SL-35 backup done; user go-ahead on timing | todo |
| SL-34 | tester | 3.3 migration tests on a throwaway DB: mixed absolute and relative rows, a row outside the storage dir, up/down/up | Criteria of SL-33 covered | `backend/tests/test_migration_relative_paths.py` (new) | SL-33 (same branch) | todo |
| SL-35 | devops | 3.3 runbook: before SL-33 is applied anywhere, take a backup with `deploy/azure/backup.sh`. Restore it into a **non-production** environment with `deploy/azure/restore.sh`, apply 0017 there with `update.sh`, check the count query, and open some attachments. Production is applied only with the user's go-ahead. | The runbook is in `deploy/azure/README.md`. The backup folder and checksums exist. On the non-prod copy the count is 0 and attachments open. The user has approved the production window. | `deploy/azure/README.md` | SL-33 (runbook written on the same branch; execution after merge) | todo |

### Blocked on data

| ID | Owner | Description | Acceptance criteria | Files touched | Depends on | Status |
|---|---|---|---|---|---|---|
| SL-36 | backend-dev | 3.5: calibrate the confidence thresholds (today 0.7 / 0.85) from finalized reports | The thresholds are justified by measured precision and recall on 50-100 finalized real reports. `GET /config` returns the new values. | `backend/app/config.py`, `backend/.env.example` | 50-100 finalized reports available (user) | blocked |

### Wave C: Phase 4, per-user sign-in

SL-37 starts as soon as Wave A is merged and can run in parallel with Wave B. It touches only `frontend/tests` and the Playwright configs, which no Wave B task edits except SL-27; SL-37 is sequenced around it. Every other C task starts after SL-35. Its migrations queue behind 0017, and its backend files (`config.py`, `main.py`, `worker.py`, routers) overlap Wave B.

| ID | Owner | Description | Acceptance criteria | Files touched | Depends on | Status |
|---|---|---|---|---|---|---|
| SL-37 | e2e-tester | 4.7 (first): every Playwright suite (e2e, built, smoke, live) signs in through one helper/fixture, behind a switch `E2E_AUTH` = `none` (default) \| `shared` \| `entra-test`. No behaviour change today. | With the switch at its default, every suite is green and unchanged. All suites get credentials from the one helper (`grep` finds no other credential code). `entra-test` fails with a clear "not available until SL-39" message. CI makes no real Entra calls. | `frontend/tests/e2e/helpers/auth.ts` (new), `frontend/tests/e2e/helpers/api.ts`, `frontend/playwright.config.ts`, `frontend/playwright.built.config.ts`, `frontend/playwright.smoke.config.ts`, `frontend/playwright.live.config.ts`, `frontend/tests/e2e-built/gate.spec.ts`, `frontend/tests/e2e-smoke/smoke.spec.ts` | Wave A merged; not in parallel with SL-27 | todo |
| SL-38 | db-engineer | 4.2: migration 0018 adds the `users` table: id, Entra object id (unique), tenant id, display name, role enum (`editor`, `read_only`), active flag, created_at, last_sign_in_at. Plus a model. The exact columns follow the answer to OQ-5. | One head, `0018_users`. `alembic check` clean. up/down/up clean. | `backend/alembic/versions/0018_users.py`, `backend/app/models/users.py` (new), `backend/app/models/__init__.py` | SL-35 (queue behind Wave B) | todo |
| SL-39 | backend-dev | 4.2: Entra token validation replaces `SharedPasswordMiddleware` when `AUTH_MODE=entra`. It checks signature (JWKS), issuer/tenant, audience and expiry, then maps the token to a `users` row, with the provisioning rule from OQ-5. `/health` stays open. CORS preflight passes. Also: a test-only issuer that can be switched on only by an explicit setting, and a request-log user id. | "Every request tied to a named user": the request log line carries the user id. No, expired, wrong-audience or wrong-tenant tokens get 401 on every route except `/health`, including malformed bodies (error precedence). `AUTH_MODE=shared` behaves exactly as today, and the existing suite is green with no changes. The test issuer is refused at startup unless explicitly enabled. | `backend/app/auth.py` (new), `backend/app/shared_password.py`, `backend/app/main.py`, `backend/app/request_trace.py`, `backend/app/config.py`, `backend/requirements.txt`, `backend/.env.example` | SL-38, SL-37 | todo |
| SL-40 | tester | 4.2 auth tests | Criteria of SL-39 covered. `test_shared_password.py` still green in `shared` mode. | `backend/tests/test_auth.py` (new), `backend/tests/test_shared_password.py`, `backend/tests/conftest.py` (authenticated-client fixture) | SL-39 (same branch) | todo |
| SL-41 | devops | 4.2 wiring: Entra settings in the deploy scripts and the smoke check. Ingress stays internal. | `deploy.sh` and `update.sh` pass the new settings. `set-secrets.sh` stores no secret in the repo. `smoke.sh` checks that `/health` is open and the app is closed without a token. README documents the app registration steps. | `deploy/azure/deploy.sh`, `deploy/azure/update.sh`, `deploy/azure/set-secrets.sh`, `deploy/azure/README.md`, `deploy/smoke.sh` | SL-39 | todo |
| SL-42 | backend-dev | 4.3: a router-level `require_editor` dependency on every write endpoint (POST/PATCH/PUT/DELETE). Read-only users get 403. | Read-only users get 403 on every write route, enumerated from `app.routes` so a new route cannot slip through. The 403 comes before body validation. Editors are unaffected. GETs are allowed for both roles. `POST /reports/parse-search` follows OQ-6. | `backend/app/auth.py`, `backend/app/routers/attachments.py`, `backend/app/routers/field_aliases.py`, `backend/app/routers/instrument_models.py`, `backend/app/routers/instrument_types.py`, `backend/app/routers/instruments.py`, `backend/app/routers/manufacturers.py`, `backend/app/routers/places.py`, `backend/app/routers/report_templates.py`, `backend/app/routers/reports.py`, `backend/app/routers/saved_filters.py`, `backend/app/routers/translations.py` | SL-39 | todo |
| SL-43 | tester | 4.3 role-matrix test | Criteria of SL-42 covered | `backend/tests/test_roles.py` (new) | SL-42 (same branch) | todo |
| SL-44 | db-engineer | 4.4: migration 0019 adds the acting-user record as agreed in CCR-03 (proposed: an `audit_events` table with actor user id, action, entity type, entity id and timestamp, because a deleted report row cannot hold its deleter) | One head. `alembic check` clean. up/down/up clean. | `backend/alembic/versions/0019_audit_events.py`, `backend/app/models/audit.py` (new), `backend/app/models/__init__.py` | SL-38, CCR-03 accepted | todo |
| SL-45 | backend-dev | 4.4: record the acting user on finalize, field edit, template confirm, delete and job creation, in the same transaction as the change | Every finalize, edit, delete and job creation writes exactly one audit row naming the user. A rolled-back write leaves no audit row. Nothing is written in `shared` mode beyond a fixed "shared" actor (per CCR-03). | `backend/app/routers/reports.py`, `backend/app/routers/attachments.py`, `backend/app/services/report_deletion.py`, `backend/app/services/audit.py` (new) | SL-44, SL-42 (serial: same routers) | todo |
| SL-46 | tester | 4.4 tests | Criteria of SL-45 covered | `backend/tests/test_audit.py` (new) | SL-45 (same branch) | todo |
| SL-47 | frontend-dev | 4.5: sign-in with MSAL (pinned `@azure/msal-browser`). `apiFetch` attaches the bearer token, renews silently, and sends the user to sign in again when the token expires or a 401 comes back. Shows who is signed in. | With `entra-test`, `apiFetch` sends a token on every call. An expired token is renewed or the user is asked to sign in again, and no unsaved edit is lost. Read-only users see write actions disabled. `tsc -b`, oxlint and Vitest green. ux-reviewer brief first; browser check before close. | `frontend/package.json`, `frontend/package-lock.json`, `frontend/src/auth/msal.ts` (new), `frontend/src/auth/AuthProvider.tsx` (new), `frontend/src/api/http.ts`, `frontend/src/main.tsx`, `frontend/src/App.tsx`, `frontend/.env.example` | SL-39, SL-37, SL-25 (both edit `api/`) | todo |
| SL-48 | frontend-dev | 4.5: file, page-image, PDF and CSV downloads work with bearer auth, as agreed in CCR-04 (today they are plain `href`/`src`/`iframe` URLs that carry no token) | The scan iframe, page PNGs, report PDF and CSV export all work when signed in with `entra-test`, on desktop and phone. No token in any URL. | `frontend/src/api/attachments.ts`, `frontend/src/api/reports.ts`, `frontend/src/components/ScanPages.tsx`, `frontend/src/components/ReportDetailScreen.tsx`, `frontend/src/components/IntakeFlow.tsx`, `frontend/src/components/TemplatePdfPicker.tsx`, `frontend/src/components/review/FieldsOnPage.tsx`, `frontend/src/components/AdminScreen.tsx` | SL-47, CCR-04 accepted | todo |
| SL-49 | db-engineer | 4.6: migration 0020 for counting failed sign-ins in the database (a multi-replica limit cannot live in memory, P-09), as agreed in CCR-05 | One head. `alembic check` clean. up/down/up clean. | `backend/alembic/versions/0020_sign_in_failures.py`, `backend/app/models/users.py` | SL-44, CCR-05 accepted | todo |
| SL-50 | backend-dev | 4.6: lockout / rate limit on failed sign-ins, counted in the database. The shared password is accepted only as a break-glass path, only while ingress is internal, and only when a setting enables it. | After N failed attempts from one source within the window, the next attempt gets 429 for both break-glass and token failures, across 2 processes. Break-glass is refused when disabled. Every break-glass use is logged. | `backend/app/auth.py`, `backend/app/shared_password.py`, `backend/app/config.py`, `backend/.env.example` | SL-49, SL-39 | todo |
| SL-51 | tester | 4.6 lockout and break-glass tests | Criteria of SL-50 covered | `backend/tests/test_sign_in_limits.py` (new), `backend/tests/test_shared_password.py` | SL-50 (same branch) | todo |
| SL-52 | backend-dev | 4.6: admin user API, editor only (list users, change role, deactivate), as agreed in CCR-06 | Read-only users get 403. An editor cannot demote or deactivate the last active editor (409). `api-schema.ts` regenerated. | `backend/app/routers/users.py` (new), `backend/app/schemas/users.py` (new), `backend/app/schemas/__init__.py`, `backend/app/main.py`, `frontend/src/generated/api-schema.ts` | SL-42, SL-45 (serial: `main.py`/auth), CCR-06 accepted | todo |
| SL-53 | frontend-dev | 4.6: admin user screen in the existing Admin area | Editors can change roles and deactivate users. Read-only users do not see the screen. ux-reviewer brief first; browser check before close. | `frontend/src/api/users.ts` (new), `frontend/src/api/index.ts`, `frontend/src/api/types.ts`, `frontend/src/components/AdminScreen.tsx`, `frontend/src/components/UsersManager.tsx` (new) | SL-52, SL-48 (both edit `AdminScreen.tsx`) | todo |
| SL-54 | e2e-tester | 4.7 end: run the suites with `E2E_AUTH=entra-test`, and add flows for sign-in, expiry, read-only 403 handling in the UI, and the admin screen | The full e2e suite is green in `entra-test` mode. The new flows pass on desktop and phone. CI runs the switch-on mode. | `frontend/tests/e2e/helpers/auth.ts`, `frontend/tests/e2e/sign-in.spec.ts` (new), `frontend/tests/e2e/roles.spec.ts` (new), `frontend/tests/e2e/admin-users.spec.ts` (new), `.github/workflows/test.yml` (env only; devops reviews) | SL-47, SL-48, SL-53, SL-42 | todo |
| SL-55 | tester | 4.6 admin API tests | Criteria of SL-52 covered | `backend/tests/test_users_api.py` (new) | SL-52 (same branch) | todo |

Gate (not a task): external ingress only after SL-37..SL-55 are done and a rate limit is in place, then by a separate user decision. Production deploys stay manual and need the user's go-ahead.

### Wave F1: UI follow-ups from the design sessions

Small UI tasks that came from design notes made in claude.ai sessions. The criteria here are the checkable version of those notes; the specs trace to these rows.

| ID | Owner | Description | Acceptance criteria | Files touched | Depends on | Status |
|---|---|---|---|---|---|---|
| SL-56 | frontend-dev | On desktop and tablet, top bar tabs that do not fit fold into a More menu instead of wrapping or being cut off. Issue #321, #322, #323. | At 1280 and 1100 px all tabs show, with no More button, and Admin sits at the right end. Narrower, tabs leave from the right into More and come back as space returns; the row never scrolls sideways or wraps. The current view's tab never folds (#322). More is a keyboard menu (Arrow keys, Home, End, Escape returns focus to More). Phone layout unchanged. The full e2e suite is green at Playwright's 1280 px default. A reviewer looks at the running app at 1280, 1100, 900 and 700 px and at 200% zoom. | `frontend/src/App.tsx`, `frontend/src/App.css`, `frontend/src/components/TopbarTabs.tsx` (new), `frontend/src/topbarOverflow.ts` (new), `frontend/src/topbarOverflow.test.ts` (new), `frontend/src/styles/12-topbar-more.css` (new), `frontend/tests/e2e/topbar-more-menu.spec.ts` (new), `docs/PLAN.md` | none | done |

## File-overlap check

Files touched by more than one task, and how the overlap is resolved:

| File | Tasks | Resolution |
|---|---|---|
| `.github/workflows/test.yml` | SL-06, SL-07, SL-54 | SL-06 then SL-07 (Wave A). SL-54 much later. |
| `frontend/package.json`, `package-lock.json` | SL-04, SL-47 | Different waves |
| `backend/app/config.py`, `backend/.env.example` | SL-14, SL-17, SL-31, SL-36, SL-39, SL-50 | Wave B is serial. Wave C backend starts after SL-35. SL-36 is blocked. |
| `backend/app/worker.py` | SL-14, SL-17, SL-31 | Serial in Wave B |
| `backend/app/models/jobs.py` | SL-12, SL-16 | Serial |
| `backend/app/models/__init__.py` | SL-19, SL-38, SL-44 | Serial (migration ledger) |
| `backend/app/models/users.py` | SL-38, SL-49 | Serial |
| `backend/app/routers/attachments.py` | SL-22, SL-31, SL-42, SL-45 | Serial: SL-22 right before SL-31, never in parallel. SL-42 then SL-45. |
| `backend/app/routers/reports.py` | SL-24, SL-42, SL-45 | Serial |
| `backend/app/services/report_deletion.py` | SL-31, SL-45 | Different waves, serial |
| `backend/app/auth.py`, `shared_password.py`, `main.py` | SL-39, SL-42, SL-50, SL-52 | Serial chain in Wave C |
| `backend/tests/test_shared_password.py` | SL-40, SL-51 | Serial |
| `frontend/src/generated/api-schema.ts` | SL-24, SL-52 | Generated. Different waves. Regenerate on rebase. |
| `frontend/src/api/reports.ts` | SL-25, SL-48 | SL-47/48 depend on SL-25 |
| `frontend/src/components/AdminScreen.tsx` | SL-25, SL-48, SL-53 | Serial: SL-25, then SL-48, then SL-53 |
| `frontend/tests/e2e/helpers/*`, Playwright configs | SL-27, SL-37, SL-54 | SL-37 not in parallel with SL-27. SL-54 last. |
| `deploy/azure/README.md` | SL-10, SL-35, SL-41 | SL-10 in Wave A, the others serial later |
| `backend/app/services/classification.py` | SL-31 only (SL-03 edits `classification_prompt.py`, a different file) | No overlap |
| `backend/app/services/privacy.py` | SL-09 only | No overlap with SL-03 |

Wave A has no overlaps apart from `test.yml` (SL-06 -> SL-07). Duplicate IDs: none (SL-01..SL-55). Migration heads: one chain, 0013 -> 0020.

## Plan problems found

- **P-01. The audit was wrong about an index.** It says `extraction_jobs.attachment_id` is already indexed (`jobs.py:69`). That line is `Translation.attachment_id`. `ExtractionJob.attachment_id` has no index in the model or in `0001_baseline.py`, so it stays in SL-12.
- **P-02. Retention vs job limits and intake.** Both job limits count `extraction_jobs` rows over a rolling 24 h. Purging inside that window would reset the cap and the retry limit, so SL-14 refuses a retention below 2 days. Also, intake reads a job's `field_confidences` (`frontend/src/components/intake/useIntakeSteps.ts`), so purging a job of an unfinished draft could break resume. I proposed keeping those jobs; the lead should confirm.
- **P-03. HEALTHCHECK.** The same image runs the worker, which has no HTTP server, so a plain `/health` probe would mark it unhealthy. The slim base image has no curl. Azure Container Apps uses its own probes (set in `deploy.sh`), so the Dockerfile instruction mainly helps local Docker. I have not verified ACA's handling.
- **P-04. "Both Claude prompts".** There are four model prompts: classify, extract, translate (`services/translation.py`) and search (`report_query_model._system_prompt`). Per the plan, SL-02/03 cover two. See OQ-3.
- **P-05. 3.6 pagination is not a back-end-only change.** `listReports` has five callers (ReportsListScreen, `useStatusCounts`, HomeScreen, InstrumentDetailScreen, InstrumentManager). The list does client-side grouping and sorting (`grouping.ts`, `reportSort.ts`). A default page size would silently truncate these, so SL-24 and SL-25 share a branch. The page and count design needs CCR-01.
- **P-06. "Paginate export" is ambiguous.** A CSV download is one file. I read the step as "stream it" (CCR-02).
- **P-07. Bearer tokens do not ride on links.** File, page-image, PDF and CSV are plain `href`/`src`/`iframe` URLs (`api/attachments.ts`, `api/reports.ts`). They work today only because the browser resends HTTP Basic. 4.5 needs a decision (CCR-04).
- **P-08. 4.4 "acting user on delete".** A deleted report row cannot hold its deleter, so an audit table is needed (CCR-03). Name clash: 3.4's "owner" is a worker, so it is named `worker_id`. 4.4's actor is a user.
- **P-09. 4.6 lockout.** Entra already locks out interactive password guessing. An app-side limit only matters for the break-glass password and for invalid-token floods. Like the search cap, it must be stored in the database to hold across replicas, which needs migration 0020 (CCR-05).
- **P-10. 3.3 risks.** (a) `restore.sh` REPLACES a deployed environment's database, so verification must use a non-production environment (SL-35). (b) Stub-mode classification hashes `attachment.file_path` (`_stable_unit`), so relative paths can change stub picks. SL-31 checks the e2e fixtures. (c) I split 3.3 into a backward-compatible code step (SL-31) and the data migration (SL-33), which ships alone. This lowers risk and adds no scope.
- **P-11. AUTH_MODE default.** The backend tests assume no auth. `AUTH_MODE` must default to `shared` (a no-op with no password set), or every existing test breaks.
- **P-12. Preflight.** The current middleware answers even `OPTIONS` with 401 (by design). With bearer tokens across origins (e2e: 5174 -> 8001), preflight carries no credentials, so the token middleware must let it through (SL-39 AC).
- **P-13. Actions pinning.** The existing workflows pin `actions/*` by tag (`@v7`, `@v8`). New or edited steps pin by SHA. Converting the existing ones is not in the plan; it is listed here, not built.
- **P-14. A possible missing index.** The daily-cap count filters all jobs by a `started_at` range, and the plan's index list has no index for it. SL-13 reports what EXPLAIN shows. No scope is added.
- **P-15. Repo vs team defaults.** The repo uses `backend/`, `frontend/`, Python 3.11, pip, models in `app/models`, e2e in `frontend/tests`, and has no `docs/API.md` or `docs/DATA_MODEL.md`. The area mapping above applies.
- **P-16. 1.1 remainder.** The plan said to replace the vendor PDFs with synthetic fixtures, but agents may not touch them. Whether they are synthetic is still unverified, so this is not a task; see OQ-1.

## Contract change requests

Agents propose API and data-model changes here. The lead accepts or rejects them before code is written.

| Date | From | Change | Status |
|---|---|---|---|
| 2026-11-12 | architect | CCR-01 (SL-24/25): `GET /reports` gains `limit` (default and max to be fixed) and `offset`. The response becomes `{items, total, status_counts}`, or stays a list with an `X-Total-Count` header. The sort order must be stable server-side, including `q` ranking. Every caller in P-05 is migrated in the same PR. | proposed |
| 2026-11-12 | architect | CCR-02 (SL-24): `GET /reports/export` keeps its URL, parameters and CSV columns but streams its rows. No shape change. | proposed |
| 2026-11-12 | architect | CCR-03 (SL-44/45): new `audit_events` table (actor_user_id, action, entity_type, entity_id, at), written in the same transaction as the change. In `shared` mode the actor is a fixed "shared" marker. | proposed |
| 2026-11-12 | architect | CCR-04 (SL-48): authenticated downloads. Either (a) fetch with the bearer token and display or download a blob (no API change), or (b) a short-lived signed download URL from a new endpoint. The architect suggests (a). | proposed |
| 2026-11-12 | architect | CCR-05 (SL-49/50): DB storage for failed sign-in counts (per source, per window). The table shape is up to db-engineer. | proposed |
| 2026-11-12 | architect | CCR-06 (SL-52): `GET /users`, `PATCH /users/{id}` (role, active), editor only. Errors follow the precedence above: 409 for the last active editor. | proposed |

## User decisions (2026-11-12)

- D-1: LICENSE is all rights reserved, copyright holder "Regev". SECURITY.md points to GitHub private vulnerability reporting; no e-mail address goes into the repo.
- D-2: Keep `ruff.toml` and `tsc -b` as merged; no `pyproject.toml`, no switch to `npm run build`.
- D-3 (was OQ-3): the injection line goes into all four prompts (classify, extract, translate, search), each with a test.
- D-4 (was OQ-4): `JOB_RETENTION_DAYS` defaults to 90. The latest job per attachment is always kept, nothing newer than 24h is deleted, and jobs of non-finalized reports are kept (P-02).
- D-5 (was OQ-5): only users an editor has added may sign in (Entra ID). The first editor is created once by the user at deploy time. The `users` table stores display name and e-mail.
- D-6 (was OQ-6): read-only users may use `POST /reports/parse-search`; it still counts against the search cap.
- D-7: worker recovery adds a `worker_id` owner column on top of the heartbeat (SL-16 and following).
- D-8: Phase 4 uses Microsoft Entra ID with two roles, editor and read-only.

## Open questions

- OQ-1 (1.1): The 3 e2e fixture PDFs and the live-run summary README were never opened by an agent. The user should check them for leftovers; the repo is public and history still holds the raw data (no-rewrite decision stands).
- OQ-2 (SL-01): The user must switch on private vulnerability reporting in the repo's Security settings.
- OQ-7 (3.3): When is the quiet window for 0017, which non-production environment is used for the restore check, and who runs `restore.sh`? Needed before Wave B reaches 3.3.
- OQ-8 (3.5): When will 50-100 finalized reports be available?
