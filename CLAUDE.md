# Agent Team: ServiceLedger

Every agent loads this file, so it is kept short. Details live in `docs/team/`: `process.md` (full workflow, collision rules, communication; lead, architect, project-manager), `knowledge.md` (ServiceLedger conventions and lessons; read the parts your task touches), `environment.md` (Postgres, worktrees, test commands, Playwright; agents that run code).

## Team
The session is the **lead/orchestrator**: it delegates, keeps the plan current, pushes branches and opens PRs. Agents: `product-manager` (brief, `AC-nn`, acceptance), `architect` (plan, `docs/tasks/SL-nn.yml`), `db-engineer` (models, migrations, seeds), `backend-dev` (`backend/app/`), `frontend-dev` (`frontend/` and its Vitest tests), `tester` (`backend/tests/`), `e2e-tester` (`frontend/tests/e2e*`, Playwright configs), `ux-reviewer` (design brief, review of the running app; read-only on code), `reviewer` (read-only review), `devops` (CI, Docker, `deploy/`), `project-manager` (status, wave reports).

## Lead lock (sessions, not agents)
- One lead session per repo, enforced by hooks (`.claude/settings.json`, `scripts/team/lead_lock.py`; details in `docs/team/process.md`). The session-start hook says who holds the lock.
- Any change to the repo is made by the session holding the lock (directly or through agents, per the token budget). Take it first: `python3 scripts/team/lead_lock.py acquire --purpose "..."`. Without it, only answer and investigate; never work around the push/merge block.

## Rules every agent follows
- Work only on your task, in your own worktree and branch (`SL-nn-...`), inside your spec's `files_touched`. Need another file: report it as a request. Never edit another agent's area.
- Commit locally, never push. Use your own throwaway database (`service_ledger_<task>_<role>`) and ports when you need them, and clean both up. The shared test database and the Playwright ports are used by one agent at a time, as the lead says.
- Never weaken or skip a CI check. Migrations are versioned and reversible; destructive changes need the user's approval; never migrate anything but a local database.
- Stub mode only (`USE_LIVE_CLAUDE=false`) unless the user says otherwise; never write a key anywhere.
- "Tests pass" is not proof a screen is right: UI work needs a look at the running app.
- Stopped mid-task means unfinished: redo, never partial credit. Max 3 fix loops per task, then the lead asks the user.
- Stack: Python 3.11, FastAPI, SQLAlchemy 2.0, Alembic, PostgreSQL 16 in `backend/`; React, TypeScript, Vite in `frontend/`. CI (`.github/workflows/test.yml`) is the authority on commands.

## Privacy
- This repository is **public**. Never open or copy anything from `docs/live-runs/` or the vendor PDFs (`frontend/tests/e2e/fixtures/`), and never quote them in issues, PRs, comments or reports.
- Reports are shared between institutes: no person's name, contact, account or contract detail in any stored field, prompt example, fixture, log line or screenshot.
- Test data uses invented names and serial numbers only. No personal e-mail addresses anywhere in the repo; `noreply@anthropic.com` in the commit trailer is the only exception. Never read, print or commit real secrets.

## User decisions
- Licence: all rights reserved. No Splunk: structured JSON logs, a worker ID column, a lightweight log viewer. Internal-only deployment today, internet-reachable and multi-replica later. At most 60 Claude jobs per day. Per-user sign-in via Microsoft Entra ID with editor and read-only roles (planned).
- Working with the user: replies in English, even when the user writes in Hebrew; product questions one at a time, with options and a recommendation; cheap details are `assumed`. Feature work stops at demo-ready with WSL run instructions.

## Token budget (lead)
The team costs many tokens because every agent starts with no memory. The user stopped a session over it (2026-11-13).
- Use the team only for large features. Small changes, fixes and follow-ups: the lead does them directly, with one reviewer pass if risky.
- Give each agent an exact list of files to read and the excerpt of the plan or brief it needs (its task rows, the `AC-nn` it covers), not "read the code around X" or whole documents.
- The implementer writes its own tests unless the plan has a reason for a separate tester; one review round, and resume the same agent for fixes.
- Screenshots and Playwright only for UI tasks. Short reports: no restating the task.
- Models: Opus for planning and review of risky code; Sonnet for building; Haiku for mechanical work (tests from a clear list, renames, doc updates).

## Report block (every agent ends with it)
```
Task: <ID>
Status: <in-review | blocked | done-nothing-to-change>
Changed files: <list>
Interface provided: <endpoints, functions, tables, or none>
Checks run: <commands and results actually seen>
Blockers: <none or list>
Requests: <one line each, prefixed with the agent that should act>
Open questions: <none or list>
```
