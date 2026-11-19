# Plan: first-run sample (A and B)

One task, built by the lead directly (small, one migration, backend and frontend that depend on each other; the token budget rule in CLAUDE.md), then one reviewer pass and a look at the running app.

| ID | Owner | Description | Acceptance | Files | Depends | Status |
|---|---|---|---|---|---|---|
| SL-79 | lead | Sample report, demo instrument, sample exclusions, delete, button, banner | AC-01..AC-05 in PRODUCT.md; tests for every exclusion in AC-03; Alembic up/down/up; real-app smoke in stub mode | see `docs/tasks/SL-79.yml` | none | in-review |

Order inside the task: migration and model, sample service (create, remove), exclusions with their tests, router and guards, schema codegen, frontend button and banner, e2e smoke.
