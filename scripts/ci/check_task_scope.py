#!/usr/bin/env python3
"""Fail if a task branch changes files outside its task spec.

The branch name must start with a task ID (e.g. SL-16-worker-id). The spec is
docs/tasks/<ID>.yml. Allowed: files matching `files_touched` (globs allowed),
plus docs/tasks/<ID>.md (the hand-off note). Branches that are not task
branches must start with one of NON_TASK_PREFIXES (lead and team housekeeping);
any other name fails, so a branch cannot skip the scope check by dropping the ID.
Usage: check_task_scope.py <branch> <base-ref>
"""
import fnmatch
import re
import subprocess
import sys
from pathlib import Path

import yaml


# Branch-name prefixes the lead may use for work that has no task spec.
NON_TASK_PREFIXES = ("spec-", "team-", "process-", "closeout-", "docs-", "dependabot/")

# LEGACY: branch-name prefixes that open PRs still use. Allowed for now so those PRs
# are not blocked; remove this tuple (and its use below) once they are merged or closed.
LEGACY_PREFIXES = ("phase", "feature/", "frontend/", "nir/", "ci/", "docs/")
ALLOWED_PREFIXES = NON_TASK_PREFIXES + LEGACY_PREFIXES


def matches(path: str, pattern: str) -> bool:
    pattern = pattern.rstrip("/")
    if fnmatch.fnmatch(path, pattern) or path.startswith(pattern + "/"):
        return True
    # "**" support: treat it as "any depth"
    regex = re.escape(pattern).replace(r"\*\*", ".*").replace(r"\*", "[^/]*")
    return re.fullmatch(regex, path) is not None


def main() -> int:
    branch, base = sys.argv[1], sys.argv[2]
    m = re.match(r"^(SL-\d+)(?:[-_]|$)", branch)
    if not m:
        if branch.startswith(ALLOWED_PREFIXES):
            print(f"Branch '{branch}' is a housekeeping branch; no task scope to check.")
            return 0
        print(f"FAIL: branch '{branch}' is neither a task branch (SL-nn-...) nor starts with one of")
        print(f"  {', '.join(ALLOWED_PREFIXES)}. Rename it, or add a task spec so its scope is checked.")
        return 1
    task = m.group(1)
    spec_path = Path(f"docs/tasks/{task}.yml")
    if not spec_path.exists():
        print(f"FAIL: {spec_path} not found. The architect must write the task spec first.")
        return 1
    spec = yaml.safe_load(spec_path.read_text()) or {}
    allowed = list(spec.get("files_touched") or [])
    if not allowed:
        print(f"FAIL: {spec_path} has no files_touched.")
        return 1
    allowed.append(f"docs/tasks/{task}.md")
    changed = subprocess.run(
        ["git", "diff", "--name-only", f"{base}...HEAD"], capture_output=True, text=True, check=True
    ).stdout.split()
    outside = [f for f in changed if not any(matches(f, p) for p in allowed)]
    if outside:
        print(f"FAIL: {task} changed files outside its files_touched:")
        for f in outside:
            print(f"  {f}")
        print("Request a spec change from the lead instead of editing other areas.")
        return 1
    print(f"ok: {len(changed)} changed file(s), all within {task}'s files_touched.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
