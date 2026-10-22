"""Read the Claude debug log (see app/debug_claude_log.py).

    python -m app.tools.show_claude_log                 # last 20 calls, one line each
    python -m app.tools.show_claude_log --report <id>   # only that report
    python -m app.tools.show_claude_log --job <id> --raw  # the full records as JSON

Filters: --report, --job, --attachment, --kind (classify, extract, translate),
--errors (only failed calls), --days N (how many days back, default 7), --last N
(how many calls, default 20, 0 = all), --dir (folder; default as the app).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.debug_claude_log import log_dir


def read_records(directory: Path, days: int) -> list[dict]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    records: list[dict] = []
    for path in sorted(directory.glob("claude-calls-*.jsonl")):
        if path.name[len("claude-calls-"):-len(".jsonl")] < cutoff:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                print(f"(skipping unreadable line {number} of {path.name})", file=sys.stderr)
    return records


def matches(record: dict, args: argparse.Namespace) -> bool:
    if args.report and record.get("report_id") != args.report:
        return False
    if args.job and record.get("job_id") != args.job:
        return False
    if args.attachment and record.get("attachment_id") != args.attachment:
        return False
    if args.kind and record.get("kind") != args.kind:
        return False
    if args.errors and "error" not in record:
        return False
    return True


def summary(record: dict) -> str:
    docs = record.get("request", {}).get("documents", [])
    doc = ", ".join(f"{d.get('media_type')} {d.get('bytes')}B sha {str(d.get('sha256'))[:10]}" for d in docs) or "no document"
    head = f"{record.get('time', '?')[:19]}  {record.get('kind', '?'):<9} {record.get('request', {}).get('model')}  {record.get('elapsed_seconds')}s"
    ids = f"job {record.get('job_id')} report {record.get('report_id')} file {record.get('file')}"
    if "error" in record:
        outcome = f"ERROR {record['error'].get('type')}: {record['error'].get('message')}"
    else:
        response = record.get("response", {})
        usage = response.get("usage", {})
        tool = next((b for b in response.get("content", []) if b.get("type") == "tool_use"), None)
        fields = len(tool["input"]) if tool and isinstance(tool.get("input"), dict) else 0
        outcome = f"stop={response.get('stop_reason')} tokens in/out={usage.get('input_tokens')}/{usage.get('output_tokens')} tool_fields={fields}"
    return f"{head}\n    {ids}\n    {doc}\n    {outcome}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Show the Claude debug log.")
    parser.add_argument("--dir", help="folder with the log files (default: as the app)")
    parser.add_argument("--report")
    parser.add_argument("--job")
    parser.add_argument("--attachment")
    parser.add_argument("--kind", choices=["classify", "extract", "translate"])
    parser.add_argument("--errors", action="store_true")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--last", type=int, default=20)
    parser.add_argument("--raw", action="store_true", help="print the full records as JSON")
    args = parser.parse_args(argv)

    directory = Path(args.dir) if args.dir else log_dir()
    if not directory.is_dir():
        print(f"No debug log folder at {directory}. Is DEBUG_CLAUDE_LOG on, and is this the right place?", file=sys.stderr)
        return 1
    records = [r for r in read_records(directory, args.days) if matches(r, args)]
    if args.last:
        records = records[-args.last:]
    if not records:
        print("No matching calls.")
        return 0
    for record in records:
        print(json.dumps(record, indent=2, ensure_ascii=False) if args.raw else summary(record))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
