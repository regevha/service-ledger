#!/usr/bin/env python3
"""Lead lock: only one Claude Code session may act as lead on this repo at a time.

The lock is a GitHub issue labelled `lead-lock`. Its body holds a JSON block with
the holder's session ID, what it is working on, and a heartbeat time. A lock with
no heartbeat for STALE_MINUTES is free.

Commands (run from the repo root; use the REST API via `gh api`):
  status                      show who holds the lock
  acquire --purpose "<text>"  take the lock (fails if another live session holds it)
          [--force]           take it even from a live holder (only when the user says so)
  release                     give the lock back (only by the holder)
  heartbeat                   refresh the heartbeat if this session holds the lock

Hook entry points (Claude Code passes the hook's JSON on stdin):
  hook-session-start          record this session's ID; print the lock status into context
  hook-pre-bash               block pushes, PR creation and merges unless this session holds the lock
  hook-heartbeat              refresh the heartbeat at most every HEARTBEAT_EVERY_MINUTES
  hook-session-end            release the lock if this session holds it

If GitHub cannot be reached, the hooks warn and let the command through, so a
network problem never locks a session out; the lead must then check by hand.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = os.environ.get("LEAD_LOCK_REPO", "regevha/service-ledger")
LABEL = "lead-lock"
TITLE = "Lead lock (do not close)"
STALE_MINUTES = 60
HEARTBEAT_EVERY_MINUTES = 10
BEGIN, END = "<!-- lead-lock:begin -->", "<!-- lead-lock:end -->"

# Bash commands that publish work and therefore need the lock.
GUARDED = [
    re.compile(r"\bgit\b(\s+-\S+(\s+\S+)?)*\s+push\b"),
    re.compile(r"\bgh\s+pr\s+(create|merge|ready)\b"),
    re.compile(r"\bgh\s+api\b.*\bpulls(/\d+/merge)?\b.*(-X|--method)\s*(POST|PUT|PATCH)\b"),
    re.compile(r"\bgh\s+api\b.*(-X|--method)\s*(POST|PUT|PATCH)\b.*\bpulls(/\d+/merge)?\b"),
]


class GitHubError(RuntimeError):
    pass


def now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def gh(*args: str, body: dict | None = None) -> object:
    cmd = ["gh", "api", *args]
    if body is not None:
        cmd += ["--input", "-"]
    try:
        out = subprocess.run(
            cmd,
            input=json.dumps(body) if body is not None else None,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GitHubError(str(exc)) from exc
    if out.returncode != 0:
        raise GitHubError(out.stderr.strip() or f"gh api exited {out.returncode}")
    return json.loads(out.stdout) if out.stdout.strip() else None


def state_dir() -> Path:
    """Per-checkout folder inside .git (shared by worktrees, never committed)."""
    try:
        common = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        path = Path(common) / "lead-lock"
    except (OSError, subprocess.CalledProcessError):
        path = Path(".lead-lock")
    path.mkdir(parents=True, exist_ok=True)
    return path


def my_session() -> str | None:
    env = os.environ.get("LEAD_SESSION_ID")
    if env:
        return env
    f = state_dir() / "session-id"
    return f.read_text().strip() or None if f.exists() else None


def find_issue() -> dict | None:
    issues = gh(f"repos/{REPO}/issues?labels={LABEL}&state=open&per_page=5")
    return issues[0] if issues else None


def ensure_issue() -> dict:
    issue = find_issue()
    if issue:
        return issue
    try:
        gh(f"repos/{REPO}/labels", "-X", "POST",
           body={"name": LABEL, "color": "5319e7", "description": "Holds the one-lead-per-repo lock"})
    except GitHubError:
        pass  # label already exists
    return gh(f"repos/{REPO}/issues", "-X", "POST",
              body={"title": TITLE, "labels": [LABEL], "body": render({})})


def parse(issue: dict | None) -> dict:
    if not issue:
        return {}
    m = re.search(re.escape(BEGIN) + r"\s*```json\s*(.*?)\s*```\s*" + re.escape(END),
                  issue.get("body") or "", re.DOTALL)
    try:
        return json.loads(m.group(1)) if m else {}
    except json.JSONDecodeError:
        return {}


def render(lock: dict) -> str:
    return (
        "Only the session named here may act as lead on this repo (push, open or merge PRs).\n"
        "Managed by `scripts/team/lead_lock.py`; see CLAUDE.md \"One lead per repo\". "
        "Do not edit by hand unless a stale lock must be cleared.\n\n"
        f"{BEGIN}\n```json\n{json.dumps(lock, indent=2)}\n```\n{END}\n"
    )


def save(issue: dict, lock: dict) -> None:
    gh(f"repos/{REPO}/issues/{issue['number']}", "-X", "PATCH", body={"body": render(lock)})


def is_live(lock: dict) -> bool:
    if not lock.get("session"):
        return False
    try:
        beat = datetime.fromisoformat(lock["heartbeat"])
    except (KeyError, ValueError):
        return False
    return now() - beat < timedelta(minutes=STALE_MINUTES)


def describe(lock: dict) -> str:
    if not lock.get("session"):
        return "The lead lock is free."
    age = ""
    try:
        mins = int((now() - datetime.fromisoformat(lock["heartbeat"])).total_seconds() // 60)
        age = f", last heartbeat {mins} min ago"
    except (KeyError, ValueError):
        pass
    live = "live" if is_live(lock) else f"STALE (over {STALE_MINUTES} min, free to take)"
    return (f"Lead lock held by session {lock['session']} ({live}{age}), "
            f"working on: {lock.get('purpose', '?')}; since {lock.get('acquired', '?')}.")


# ---- commands -------------------------------------------------------------

def cmd_status() -> int:
    lock = parse(find_issue())
    print(describe(lock))
    me = my_session()
    if me and lock.get("session") == me:
        print("This session holds the lock.")
    return 0


def cmd_acquire(purpose: str, force: bool) -> int:
    me = my_session()
    if not me:
        print("No session ID recorded (the SessionStart hook did not run). "
              "Set LEAD_SESSION_ID or start a new session.", file=sys.stderr)
        return 1
    issue = ensure_issue()
    lock = parse(issue)
    if is_live(lock) and lock["session"] != me and not force:
        print("REFUSED: " + describe(lock), file=sys.stderr)
        print("Coordinate with that session, wait for it to go stale, or take over with --force "
              "only if the user says so.", file=sys.stderr)
        return 1
    stamp = now().isoformat()
    acquired = lock["acquired"] if lock.get("session") == me else stamp
    new = {"session": me, "purpose": purpose, "acquired": acquired, "heartbeat": stamp}
    if force and lock.get("session") not in (None, me):
        new["took_over_from"] = lock["session"]
    save(issue, new)
    (state_dir() / "last-heartbeat").write_text(stamp)
    print(f"Lead lock acquired by {me}: {purpose}")
    return 0


def cmd_release() -> int:
    me = my_session()
    issue = find_issue()
    lock = parse(issue)
    if not issue or lock.get("session") != me:
        print("This session does not hold the lead lock; nothing to release.")
        return 0
    save(issue, {})
    print("Lead lock released.")
    return 0


def cmd_heartbeat(throttled: bool) -> int:
    me = my_session()
    if not me:
        return 0
    marker = state_dir() / "last-heartbeat"
    if throttled and marker.exists():
        try:
            last = datetime.fromisoformat(marker.read_text().strip())
            if now() - last < timedelta(minutes=HEARTBEAT_EVERY_MINUTES):
                return 0
        except ValueError:
            pass
    issue = find_issue()
    lock = parse(issue)
    if issue and lock.get("session") == me:
        lock["heartbeat"] = now().isoformat()
        save(issue, lock)
    marker.write_text(now().isoformat())
    return 0


# ---- hooks ----------------------------------------------------------------

def read_hook_input() -> dict:
    try:
        return json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return {}


def hook_session_start() -> int:
    data = read_hook_input()
    sid = data.get("session_id")
    if sid:
        (state_dir() / "session-id").write_text(sid)
    try:
        lock = parse(find_issue())
    except GitHubError as exc:
        print(f"[lead-lock] Could not read the lead lock ({exc}). Check it by hand before "
              "pushing or merging: python3 scripts/team/lead_lock.py status")
        return 0
    msg = ["[lead-lock] " + describe(lock)]
    if lock.get("session") == sid:
        msg.append("This session holds the lock.")
    elif is_live(lock):
        msg.append("Another session is the lead. This session may answer questions and "
                   "investigate, but must not change code, push, open or merge PRs. "
                   "Tell the user which session holds the lock.")
    else:
        msg.append("Before changing code, take the lock: "
                   "python3 scripts/team/lead_lock.py acquire --purpose \"<what this session will do>\"")
    print(" ".join(msg))
    return 0


def hook_pre_bash() -> int:
    data = read_hook_input()
    command = (data.get("tool_input") or {}).get("command", "")
    if not any(p.search(command) for p in GUARDED):
        return 0
    sid = data.get("session_id") or my_session()
    try:
        lock = parse(find_issue())
    except GitHubError as exc:
        print(f"[lead-lock] warning: could not check the lead lock ({exc}); allowing the command. "
              "Confirm no other session is lead.", file=sys.stderr)
        return 0
    if lock.get("session") == sid and is_live(lock):
        return 0
    if lock.get("session") == sid:
        print("[lead-lock] Your lock went stale. Re-take it first: "
              "python3 scripts/team/lead_lock.py acquire --purpose \"...\"", file=sys.stderr)
    elif is_live(lock):
        print("[lead-lock] BLOCKED: " + describe(lock) + " Only the lead session may push, open "
              "or merge PRs. Tell the user; do not work around this.", file=sys.stderr)
    else:
        print("[lead-lock] BLOCKED: this session does not hold the lead lock. Take it first: "
              "python3 scripts/team/lead_lock.py acquire --purpose \"...\"", file=sys.stderr)
    return 2


def hook_heartbeat() -> int:
    read_hook_input()
    try:
        return cmd_heartbeat(throttled=True)
    except GitHubError:
        return 0


def hook_session_end() -> int:
    read_hook_input()
    try:
        return cmd_release()
    except GitHubError:
        return 0


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1
    cmd, rest = argv[0], argv[1:]
    try:
        if cmd == "status":
            return cmd_status()
        if cmd == "acquire":
            purpose = rest[rest.index("--purpose") + 1] if "--purpose" in rest else "unspecified"
            return cmd_acquire(purpose, force="--force" in rest)
        if cmd == "release":
            return cmd_release()
        if cmd == "heartbeat":
            return cmd_heartbeat(throttled=False)
        hooks = {
            "hook-session-start": hook_session_start,
            "hook-pre-bash": hook_pre_bash,
            "hook-heartbeat": hook_heartbeat,
            "hook-session-end": hook_session_end,
        }
        if cmd in hooks:
            return hooks[cmd]()
    except GitHubError as exc:
        print(f"GitHub error: {exc}", file=sys.stderr)
        return 1
    print(f"Unknown command: {cmd}\n{__doc__}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
