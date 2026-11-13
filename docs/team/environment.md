# Local environment and commands (cloud workspace)

For agents that run code, tests or servers. Moved here from CLAUDE.md.

- Postgres: `pg_ctlcluster 16 main start` (stops between sessions). Role `service_ledger` / `service_ledger_dev`.
- **Isolation:** each agent uses its own databases named `service_ledger_<task>_<role>` (lower case, e.g. `service_ledger_sl20_tester`), creates them, and drops them when done; ports `8100 + slot` for the API and `5200 + slot` for Vite (the lead assigns the slot). The full backend suite (`service_ledger_test`) and Playwright (`service_ledger_e2e`, fixed ports 8001 and 5174) use shared databases and ports: only one agent runs each at a time, the one the lead names.
- Backend: `cd backend && .venv/bin/python -m pytest -p no:randomly` (full suite about 8 minutes locally; run the relevant files first with `--no-cov`), `.venv/bin/ruff check .` (ruff 0.17.4), `.venv/bin/mypy app` (error count must not exceed `backend/mypy-baseline.txt`).
- Frontend: `cd frontend && npx tsc -b && npx oxlint && npx vitest run && npm run build`.
- Playwright: Chromium is under `/opt/pw-browsers` with a build number that differs from what Playwright wants; symlink it into a temporary `PLAYWRIGHT_BROWSERS_PATH` under the requested name. Run with `backend/.venv/bin` on PATH: `npx playwright test tests/e2e/<spec>`.
- A real browser check (Playwright screenshot of the running page) is required before a UI task is `in-review`. "Tests pass" is not evidence that a screen is right.
