# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Regenerating API types from the backend

`src/api.ts` derives its five backend-enum types (`InstrumentStatus`,
`ReportType`, `ReportStatus`, `ExtractionJobStatus`, `ExtractionJobKind`) from
`src/generated/api-schema.ts` rather than hand-typing them — that file is
generated from the backend's own OpenAPI schema, so it can't silently drift
from `backend/app/models.py`'s real enum classes the way a hand-copied union
type could. `src/generated/api-schema.ts` is committed (so a build never
needs Python or a backend checkout); regenerate it after changing a backend
enum or any response shape those five types touch:

```bash
# 1. From backend/, with its venv active — no running server or database
#    needed, this only imports the already-defined FastAPI app object:
python -m scripts.export_openapi > ../frontend/openapi.json

# 2. From frontend/ — turns that schema into real TypeScript types:
npm run codegen
```

The other hand-written interfaces in `api.ts` (`Instrument`, `Report`,
`ReportTemplate`, ...) are left alone on purpose — they're small, stable, and
more readable authored directly than as a deep generated-schema lookup; only
the enums, where backend/frontend drift is easy and silent, are sourced from
the generated file.

## End-to-end tests (Playwright)

`tests/e2e/` covers the flows a screen-by-screen manual pass would otherwise
have to re-check before every milestone: the confident upload→classify→
extract→review→finalize happy path, the uncertain-report-type manual-confirm
detour, the reports search/filter screen (including the empty state and
editing an already-finalized report), CSV export, and the app's error states
(an unreachable backend, a failed classification call).

```bash
npm run test:e2e       # headless run
npm run test:e2e:ui    # Playwright's interactive UI mode
```

`playwright.config.ts` boots its own backend (stub-mode — `USE_LIVE_CLAUDE=false`,
so this never spends a real API call), its own instance of the background
worker (`app/worker.py`, §3 — classify/extract only enqueue a job now, so
nothing in this suite would ever leave "pending" without one running), and
its own Vite dev server, all on dedicated ports (8001 / 5174 for the
backend/frontend — the worker has no port of its own), so it never touches
the ports a developer might already have running for manual testing
(8000 / 5173) and never runs against real Claude. It truncates its database
before every run via `backend/app/testing/reset_db.py`, then relies on
`app.main`'s own startup hook to reseed the instrument fleet and report
templates — see that router's docstring for why this is a *separate*
database from `backend/tests/conftest.py`'s `service_ledger_test`.

**One-time setup**: this suite needs its own Postgres database
(`service_ledger_e2e`), owned by the same role the backend already uses,
created once per environment — it isn't provisioned automatically because
the app's own DB role doesn't have `CREATEDB`:

```bash
sudo -u postgres createdb service_ledger_e2e
sudo -u postgres psql -c "ALTER DATABASE service_ledger_e2e OWNER TO service_ledger;"
```
