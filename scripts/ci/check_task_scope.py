#!/usr/bin/env python3
"""Fail if a task branch changes files outside its task spec.

The branch name must start with a task ID (e.g. SL-16-worker-id). The spec is
docs/tasks/<ID>.yml. Allowed: files matching `files_touched` (globs allowed),
plus docs/tasks/<ID>.md (the hand-off note). Branches that are not task
branches must start with one of NON_TASK_PREFIXES (lead and team housekeeping)
or with a prefix listed in docs/team/branch_exemptions on the BASE ref (one per line, '#' comments, blank
lines ignored; a PR cannot exempt itself). A missing file means no exemptions; any other git error fails the
check. Any other name fails, so a branch cannot skip the scope check by dropping the ID.
Usage: check_task_scope.py <branch> <base-ref>
       check_task_scope.py --self-test
"""
import fnmatch
import os
import re
import subprocess
import sys
from pathlib import Path

import yaml


# Branch-name prefixes the lead may use for work that has no task spec.
NON_TASK_PREFIXES = ("spec-", "team-", "process-", "closeout-", "docs-")

# Per-repo exemptions (dependabot/, legacy prefixes of open PRs) live in this file, read from the BASE ref.
EXEMPTIONS_PATH = "docs/team/branch_exemptions"


def parse_exemptions(text: str) -> list[str]:
    """One prefix per line; '#' starts a comment; blank lines are ignored (an empty prefix would exempt everything)."""
    lines = (line.split("#", 1)[0].strip() for line in text.splitlines())
    return [line for line in lines if line]


def load_exemptions(base: str) -> list[str]:
    """Read the list from the BASE ref so a PR cannot exempt its own branch. Missing file = none."""
    env = {**os.environ, "LC_ALL": "C"}  # the missing-file check below reads git's English message
    proc = subprocess.run(["git", "show", f"{base}:{EXEMPTIONS_PATH}"], capture_output=True, text=True, env=env)
    if proc.returncode == 0:
        return parse_exemptions(proc.stdout)
    if "does not exist" in proc.stderr or "exists on disk, but not in" in proc.stderr:
        return []
    raise RuntimeError(f"cannot read {EXEMPTIONS_PATH} from {base}: {proc.stderr.strip()}")


def is_allowed_non_task(branch: str, exempt: list[str]) -> bool:
    return branch.startswith(NON_TASK_PREFIXES + tuple(exempt))


def check(cond: bool, what: str) -> None:
    if not cond:
        print(f"self-test FAILED: {what}")
        raise SystemExit(1)


def self_test() -> int:
    import tempfile

    check(parse_exemptions("# c\n\n  dependabot/  # bots\n   \nfeature/\n") == ["dependabot/", "feature/"], "parse, blanks ignored")
    check(parse_exemptions("\n  \n# only comment\n") == [], "empty list stays empty")
    check(is_allowed_non_task("spec-x", []), "housekeeping prefix")
    check(not is_allowed_non_task("dependabot/pip/x", []), "dependabot fails without the file")
    check(is_allowed_non_task("dependabot/pip/x", ["dependabot/"]), "listed prefix passes")
    check(not is_allowed_non_task("x-dependabot/y", ["dependabot/"]), "prefix, not substring")
    check(not is_allowed_non_task("feature-x", ["dependabot/"]), "other names fail")

    def sh(cwd, *args):
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args], cwd=cwd, check=True,
                       capture_output=True)

    here = os.getcwd()
    script = os.path.abspath(__file__)
    with tempfile.TemporaryDirectory() as d:
        sh(d, "init", "-q", "-b", "main")
        sh(d, "commit", "-q", "--allow-empty", "-m", "base without the file")
        os.chdir(d)
        try:
            check(load_exemptions("main") == [], "missing file on base means no exemptions")
            try:
                load_exemptions("no-such-ref")
                check(False, "a bad base ref must raise")
            except RuntimeError:
                pass
            sh(d, "checkout", "-q", "-b", "pr")
            os.makedirs("docs/team")
            with open(EXEMPTIONS_PATH, "w") as f:
                f.write("extra/\n")
            sh(d, "add", "-A")
            sh(d, "commit", "-q", "-m", "pr adds its own exemption")
            check(load_exemptions("main") == [], "a PR cannot exempt its own branch")
            sh(d, "checkout", "-q", "main")
            os.makedirs("docs/team", exist_ok=True)
            with open(EXEMPTIONS_PATH, "w") as f:
                f.write("# c\ndependabot/\n\n")
            sh(d, "add", "-A")
            sh(d, "commit", "-q", "-m", "base gets the list")
            sh(d, "checkout", "-q", "pr")
            check(load_exemptions("main") == ["dependabot/"], "list is read from the base ref")
            for branch, want in (("dependabot/x", 0), ("feature-x", 1)):
                rc = subprocess.run([sys.executable, script, branch, "main"], cwd=d, capture_output=True).returncode
                check(rc == want, f"script exit code for {branch}: got {rc}, want {want}")
        finally:
            os.chdir(here)
    print("self-test ok")
    return 0


def matches(path: str, pattern: str) -> bool:
    pattern = pattern.rstrip("/")
    if fnmatch.fnmatch(path, pattern) or path.startswith(pattern + "/"):
        return True
    # "**" support: treat it as "any depth"
    regex = re.escape(pattern).replace(r"\*\*", ".*").replace(r"\*", "[^/]*")
    return re.fullmatch(regex, path) is not None


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    branch, base = sys.argv[1], sys.argv[2]
    try:
        exempt = load_exemptions(base)
    except RuntimeError as e:
        print(f"FAIL: {e}")
        return 1
    m = re.match(r"^(SL-\d+)(?:[-_]|$)", branch)
    if not m:
        if is_allowed_non_task(branch, exempt):
            print(f"Branch '{branch}' is a housekeeping branch; no task scope to check.")
            return 0
        print(f"FAIL: branch '{branch}' is neither a task branch (SL-nn-...) nor starts with one of")
        print(f"  {', '.join(NON_TASK_PREFIXES + tuple(exempt))}. Rename it, or add a task spec so its scope is checked.")
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
