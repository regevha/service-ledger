# Task files

Each task has up to two files here, with different writers so they never collide.

| File | Written by | Purpose |
| --- | --- | --- |
| `SL-nn.yml` | `architect` | The task's spec, read by the lead's overlap gate and by CI (`scripts/ci/check_task_scope.py`) |
| `SL-nn.md` | the task's owner | Hand-off note: what was built, the interface it exposes, what the next agent needs |

Task IDs are the `SL-nn` IDs in `docs/PLAN.md`. A task branch is named `SL-nn-short-name`
(for example `SL-16-worker-id`), so CI can find the spec `docs/tasks/SL-16.yml`.

## `SL-nn.yml` format

```yaml
id: SL-16
title: Worker ID column on jobs
owner: db-engineer          # db-engineer | backend-dev | frontend-dev | tester | e2e-tester | devops
branch: SL-16-worker-id
wave: 2
depends_on: [SL-12]
migration: false            # true for at most one task per wave
files_touched:              # complete list, globs allowed; include wiring files and lockfiles
  - backend/app/models.py
  - backend/alembic/versions/0017_worker_id.py
  - backend/app/main.py
acceptance: [SL-16]         # the acceptance criteria or plan section the task traces to
issue: 12                   # GitHub issue number, once it exists
```

## Overlap rule

Two tasks in the same wave must have disjoint `files_touched`. The lead and `project-manager`
check this before each wave. CI fails a task branch that changes a file outside its
`files_touched` (plus `docs/tasks/SL-nn.md`).

## `SL-nn.md` hand-off note

Short: what was built, the interface provided, decisions made, anything the next agent must know.
