# Team process in full

The lead, architect and project-manager follow this; other agents need only CLAUDE.md and their task spec. Moved here from CLAUDE.md.

## Workflow (every feature)
0. **Product** (new user-facing feature only): delegate to `product-manager` for a brief with acceptance criteria. Put its open product questions to the user one at a time (see "Working with the user") and wait for answers (or record them as `assumed`) before planning.
1. **Plan**: delegate to `architect`. Every task's acceptance criteria must trace to a plan section or acceptance criterion. It writes/updates `docs/PLAN.md` and the `docs/tasks/SL-nn.yml` specs.
2. **Data**: if the feature changes data, `db-engineer` goes first: migration, model, seed. Backend work that needs it waits.
3. **Design** (any task with UI): `ux-reviewer` writes a design brief first; `frontend-dev` builds to it. After the build, `ux-reviewer` reviews the running app alongside `reviewer`.
3b. **Build**: delegate independent tasks to `backend-dev` and `frontend-dev` in parallel. Tasks touching the same files run sequentially.
4. **Test**: delegate to `tester` with the task's acceptance criteria, including Alembic upgrade/downgrade/upgrade on a fresh DB. For any task touching both `frontend/` and `backend/`, also delegate to `e2e-tester` for the browser flow.
5. **Review**: delegate to `reviewer`; for features with a brief, also `product-manager` for acceptance. If it returns blocking issues, send them back to the owning agent, then re-test and re-review.
6. **Close**: mark the task done in `docs/PLAN.md` only after test, review, green CI and (when there is a brief) product acceptance all pass.
7. **Report**: after each wave, delegate to `project-manager` with the agents' reports; it updates statuses and proposes the next wave. Only the lead sets `done`.
8. **Ship**: merged work deploys via `devops` pipelines. Production deploys are manual and need the user's explicit go-ahead.

## Shared rules
- `docs/PLAN.md` is the single source of truth for status. Agents update only their own task rows.
- Statuses: `todo`, `in-progress`, `blocked`, `in-review` (set by the implementing agent when its own checks pass), `done` (set **only by the lead**, after test + review + green CI).
- Root and scaffold files (`.gitignore`, root README, tooling configs) belong to `devops`; the lead may create them when no devops task exists.
- Importing a declared interface across areas is allowed. Changing such an interface needs a note in the `docs/PLAN.md` "Contract change requests" section (or a `needs-decision` issue if the plan has none).
- When a fix lands for a defect a tester reported, the lead sends a follow-up to `tester` to remove `todo` flags and re-verify.
- **Stack:** Python 3.11 + FastAPI + SQLAlchemy 2.0 + Alembic + PostgreSQL 16 in `backend/` (code in `backend/app/`, migrations in `backend/alembic/versions/`, tests with pytest in `backend/tests/`); React + TypeScript + Vite in `frontend/`; Playwright e2e in `frontend/tests/e2e*`.
- **Commands** (CI is `.github/workflows/test.yml`; it is the authority if this list drifts):
  - Backend, from `backend/`, with a local Postgres (role/password as in `backend/README.md`): `ruff check .`; `pip install mypy==2.4.1` (the version CI pins) then `mypy app`, whose `: error:` count may not rise above `backend/mypy-baseline.txt` (a PR that lowers the count lowers the baseline too); `pytest` (CI runs `pytest -q --cov -n auto --dist loadfile -p no:randomly`; the coverage floor is in `backend/.coveragerc`); `alembic upgrade head && alembic check` (models must match migrations).
  - Frontend, from `frontend/`: `npm ci`; `npx oxlint`; `npx tsc -b`; `npm test` (Vitest); `npm run codegen` when the API schema changes (the committed `src/generated/api-schema.ts` must match); `npx playwright test` (e2e; `npm run test:e2e:built` for the built page).
- Ownership: db-engineer `backend/alembic/`, `backend/app/models/` and seeds; backend `backend/app/` otherwise; frontend `frontend/` (including its unit tests); tester `backend/tests/`; e2e-tester `frontend/tests/e2e*` and the Playwright configs. Do not edit another agent's area; report a request instead.
- Schema changes are only ever versioned, reversible migrations. Destructive changes (dropping tables or columns, data loss) require explicit user approval before they run.
- Never run migrations against anything but a local/dev database. Never weaken or skip a CI check to get green; ask the user instead.
- **Lessons (process rules):**
  - Never run two agents at once that edit files the other one tests or builds on. Sequence them, or give each its own checkout. Every agent that starts servers uses its own ports and its own throwaway database, and cleans both up.
  - From the first UI task on, the reviewer and the tester check in a real browser (Playwright), not only in unit tests. A short browser smoke test is an in-review gate for each UI task, before the full e2e wave.
  - Which document wins on a conflict: product brief (what) over API/data contracts over design brief over `docs/PLAN.md` (tasks). An agent that finds a conflict reports it to the lead, not silently picks one.
  - Run the project-manager's plan-health check (file overlaps, missing dependencies, contradictions between docs, duplicate task IDs) before launching each wave.
  - "Tests pass" is not evidence that the screen is right. Closing a UI task needs a reviewer or ux-reviewer who looked at the running app.
  - A change that sends new things to an existing screen (more files, a new state, a new kind of item) also gets a ux-reviewer look at that screen as it is, with realistic data in every state, not only at the new parts. Lesson from SL-59: several PDFs from New report landed on a batch screen that repeated the same sentence and buttons on every row and offered no action for a whole group (user feedback 2026-11-13, now SL-60).
  - Task IDs are unique across plan files; agents add rows only after re-reading the file, and edit only their own row.
  - Agents that are stopped mid-task leave unfinished files; treat those as unfinished and redo them, never as partial credit.
- Max 3 fix loops per task, then escalate to the user with a summary.

## Feature work (the user's feature requests)
- A user-facing feature gets a folder `docs/features/<feature>/` with `PRODUCT.md` (product-manager), `API.md` and `DATA_MODEL.md` (architect, then db-engineer), `DESIGN.md` (ux-reviewer). Its tasks are a new section in `docs/PLAN.md` with `SL-nn` IDs continuing after the highest one in use; the hardening sections are left alone.
- **Stop at demo-ready** applies to feature work (not to the hardening plan): when the feature's must-have criteria are met, the lead stops, gives the user the **WSL run instructions** for the feature branch (`~/service-ledger` in WSL2 Ubuntu: fetch, check out, migrate, seed demo data, start the API, the worker and Vite) and asks whether to continue. Nothing beyond the brief is built.
- Live Claude calls cost money: agents work in stub mode (`USE_LIVE_CLAUDE=false`, the default) unless the user says otherwise; any outside service (mail, HTTP) gets a fake that tests and the WSL demo use.

## Collision avoidance (lead enforces)
- **One task, one worktree, one branch, one PR.** Each build agent works in its own git worktree on a branch named after its task (`SL-16-worker-id`) and opens one PR. Reviewer and tester check the PR's commit, never a tree that is still changing. Merge PRs one at a time, rebasing the next on the result. **Agents commit locally and never push**; the lead pushes and opens the PR from the agent's report and hand-off note.
- **Overlap gate:** before launching a wave, compare the `Files touched` of every task. Never run two tasks at once if their lists intersect. Wiring files (`backend/app/main.py`, routers, `frontend/src/App.tsx`, `main.tsx`) and lockfiles count as files touched.
- **CI enforces two of these** (`.github/workflows/team-checks.yml`): a task branch (`SL-nn-...`) may change only the files in its `docs/tasks/SL-nn.yml` `files_touched` (plus `docs/tasks/SL-nn.md`), and each Alembic versions folder must have exactly one head. If the scope check fails, ask the lead for a spec change; never weaken the check.
- **Branch names:** a task branch starts with its task ID (`SL-16-...`); the lead's housekeeping branches start with `spec-`, `team-`, `process-`, `closeout-` or `docs-` (and `dependabot/`). CI fails any other name, so a branch cannot skip the scope check by leaving out the ID. Until the open PRs that use them are merged or closed, CI also tolerates the legacy prefixes `phase`, `feature/`, `frontend/`, `nir/`, `ci/` and `docs/` (`LEGACY_PREFIXES` in `scripts/ci/check_task_scope.py`); do not use them for new work, and remove them from the script later.
- **One lead per repo:** only one lead session works on this repo at a time. Before launching a wave the lead lists open PRs and branches (`gh pr list`, `git branch -r`) and reads the open request issues; work that already exists on another branch is merged or closed first, never rebuilt.
- **Wave size:** at most 3 build agents at once.
- **Migrations:** at most one migration task per wave, so there is only ever one Alembic head.
- **Dependencies:** adding a package (`backend/requirements.txt`, `frontend/package-lock.json`) is a request to the lead, applied by one agent per side at the start of the wave, not edited by parallel agents.
- **Contracts:** the API schema (and the generated `frontend/src/generated/api-schema.ts`) and the data model are frozen during a wave. Contract change requests are applied between waves, except for a Blocking defect.
- **Ports and databases:** each agent uses port `base + slot` (the lead assigns the slot) and a database named `service_ledger_<task>_<agent>`, and states in its report that both were cleaned up.

## Communication
- The lead is the hub. Agents do not message each other; they put requests to other agents in their report and the lead routes them.
- **Task spec:** `architect` writes `docs/tasks/SL-nn.yml` per task (owner, branch, wave, dependencies, `files_touched`, acceptance); the overlap gate reads it. Format in `docs/tasks/README.md`.
- **Hand-off note:** every task leaves `docs/tasks/SL-nn.md`: what was built, the interface it exposes, and what the next agent needs to know. Only the task's owner writes it.
- **GitHub is the shared record:** one issue per task (acceptance criteria, `Files touched`, dependencies), progress and hand-off as comments on it, review findings as PR line comments, defects as linked issues, questions for the user as a `needs-decision` issue. `docs/PLAN.md` stays the single source of truth for status.
- **Requests become issues:** every line under `Requests:` or `Open questions:` in an agent report, and every Suggestion in a review, is turned by the lead into a GitHub issue before the session ends, labelled `task`, `needs-decision` or `deferred` (with a one-line reason for deferring). Nothing stays only in a report.
- **Review before merge:** a task PR is merged only after `reviewer` returns APPROVE on its commit and CI is green. Spec PRs are read by the lead against the overlap gate before merging. The review is recorded as a comment on the PR.
- **Fix loops:** the lead resumes the same agent session rather than starting a new one, so the agent keeps its context.
- Every agent ends its reply with this block (add role-specific lines such as Migration status or Verdict):

```
Task: <ID>
Status: <in-review | blocked | done-nothing-to-change>
Changed files: <list>
Interface provided: <endpoints, functions, tables, or none>
Blockers: <none or list>
Requests: <one line per request, prefixed with the agent that should act: e.g. db-engineer: add index on jobs.owner>
Open questions: <none or list>
```
