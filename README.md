# ServiceLedger

[![Tests](https://github.com/regevha/service-ledger/actions/workflows/test.yml/badge.svg)](https://github.com/regevha/service-ledger/actions/workflows/test.yml)

A document-first service ledger for a small fleet of lab instruments (flow
cytometers, to start): technicians upload a scanned service report, Claude
classifies which instrument and report type it is and extracts the
structured fields, and the technician reviews/corrects the result before
finalizing it. Reports become searchable, exportable, and chartable
(per-instrument trend lines, fleet-wide analytics) once finalized.

This repo is a real, running implementation of the design in
[`docs/service-ledger-spec.html`](docs/service-ledger-spec.html) (SL-ARCH-001,
the architecture spec) and [`docs/service-ledger-tdd.html`](docs/service-ledger-tdd.html)
(SL-TDD-001, the technical design doc) — not a prototype of it. Real FastAPI
+ Postgres backend, real Alembic migrations, a real background worker, a
real React frontend, and both a deterministic stub and a live path against
the real Claude API for classification/extraction.

## Repo layout

```
backend/    FastAPI + Postgres API, background worker, Alembic migrations, tests
frontend/   React + TypeScript + Vite app, Playwright e2e tests
docs/       Architecture spec, technical design doc, build tracker, demo script + demo HTML mockups
```

Each half has its own README with full setup and run instructions:

- [`backend/README.md`](backend/README.md) — what's in the backend, running the
  API + worker, the document-first flow end to end, template management,
  swapping in the real Claude API, and known gaps.
- [`frontend/README.md`](frontend/README.md) — the app, regenerating API types
  from the backend's OpenAPI schema, and the Playwright e2e/live-smoke suites.

## Quick start

Requires Postgres, Python 3, and Node.

```bash
# 1. Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # adjust DATABASE_URL etc. for your setup
alembic upgrade head
python -m app.seed_instruments
python -m app.seed_templates
uvicorn app.main:app --reload   # → http://127.0.0.1:8000/docs

# 2. Background worker (second terminal, same venv)
cd backend && python -m app.worker

# 3. Frontend (third terminal)
cd frontend
npm install
cp .env.example .env.local
npm run dev                     # → http://localhost:5173
```

Without the worker running, uploads stay stuck at "pending" — nothing else
calls `classify()`/`extract()`. See `backend/README.md`'s "Running it"
section for seeding optional demo/trend data, and "Swapping in the real
Claude API" for going from the deterministic stub to a live model.

## Testing

```bash
# Backend — 298 tests against a real (separate) Postgres test database
cd backend && pytest

# Frontend — 16 Playwright specs / 31 tests against a running backend
cd frontend && npm run test:e2e
```

Both suites also run in CI (`.github/workflows/test.yml`) against a fresh
`postgres:16` service container on every push to `main` and every pull
request — see the badge at the top of this file.

An opt-in live-Claude smoke test (`frontend/tests/e2e-live/`) and a
CLI-driven demo script (`docs/service-ledger-demo-script.md`) are also
available — see `frontend/README.md` and that script for details.

## Docs

- [`docs/service-ledger-spec.html`](docs/service-ledger-spec.html) — SL-ARCH-001, the architecture/product spec.
- [`docs/service-ledger-tdd.html`](docs/service-ledger-tdd.html) — SL-TDD-001, the technical design doc (modules, request lifecycles, API surface).
- [`docs/service-ledger-tracker.html`](docs/service-ledger-tracker.html) — build tracker against the spec.
- [`docs/service-ledger-demo-script.md`](docs/service-ledger-demo-script.md) — a presenter's walkthrough of the app end to end.
- `docs/*-demo.html` — standalone UI mockups the real screens were built against.
