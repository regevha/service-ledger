"""The command-line viewer for the Claude debug log."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from app.tools.show_claude_log import main


def _record(kind="classify", job="job-1", report="rep-1", attachment="att-1", error=None, when=None):
    r = {
        "time": (when or datetime.now(timezone.utc)).isoformat(),
        "level": "light", "kind": kind, "job_id": job, "report_id": report, "attachment_id": attachment, "file": "scan.pdf",
        "request": {"model": "claude-test", "documents": [{"type": "document", "media_type": "application/pdf", "bytes": 1234, "sha256": "abcdef0123456789"}]},
        "elapsed_seconds": 2.5,
    }
    if error:
        r["error"] = {"type": "APIConnectionError", "message": error}
    else:
        r["response"] = {"stop_reason": "tool_use", "usage": {"input_tokens": 100, "output_tokens": 20},
                         "content": [{"type": "tool_use", "name": "t", "input": {"a": 1, "b": 2, "c": 3}}]}
    return r


@pytest.fixture
def folder(tmp_path):
    today = datetime.now(timezone.utc)
    (tmp_path / f"claude-calls-{today.date().isoformat()}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in [
            _record("classify", "job-1", "rep-1"),
            _record("extract", "job-2", "rep-1"),
            _record("translate", "job-3", "rep-2", attachment="att-9"),
            _record("classify", "job-4", "rep-2", error="boom"),
        ]) + "\nnot json at all\n"
    )
    old = today - timedelta(days=10)
    (tmp_path / f"claude-calls-{old.date().isoformat()}.jsonl").write_text(json.dumps(_record("classify", "job-old", "rep-old", when=old)) + "\n")
    return tmp_path


def _run(capsys, folder, *args):
    code = main(["--dir", str(folder), *args])
    out = capsys.readouterr()
    return code, out.out, out.err


def test_the_default_view_is_a_short_summary_per_call(capsys, folder):
    code, out, err = _run(capsys, folder)
    assert code == 0
    assert out.count("claude-test") == 4
    assert "stop=tool_use tokens in/out=100/20 tool_fields=3" in out
    assert "application/pdf 1234B sha abcdef0123" in out
    assert "ERROR APIConnectionError: boom" in out
    assert "skipping unreadable line" in err
    assert "job-old" not in out  # older than 7 days


@pytest.mark.parametrize("args,expected", [
    (["--report", "rep-1"], {"job-1", "job-2"}),
    (["--job", "job-3"], {"job-3"}),
    (["--attachment", "att-9"], {"job-3"}),
    (["--kind", "classify"], {"job-1", "job-4"}),
    (["--errors"], {"job-4"}),
    (["--report", "rep-2", "--kind", "classify"], {"job-4"}),
])
def test_filters(capsys, folder, args, expected):
    _, out, _ = _run(capsys, folder, *args)
    shown = {j for j in ("job-1", "job-2", "job-3", "job-4") if f"job {j} " in out}
    assert shown == expected


def test_days_widens_the_window(capsys, folder):
    _, out, _ = _run(capsys, folder, "--days", "30")
    assert "job-old" in out


def test_last_limits_and_zero_means_all(capsys, folder):
    _, out, _ = _run(capsys, folder, "--last", "2")
    assert out.count("claude-test") == 2 and "job-4" in out and "job-3" in out
    _, out, _ = _run(capsys, folder, "--last", "0", "--days", "30")
    assert out.count("claude-test") == 5


def test_raw_prints_full_json(capsys, folder):
    _, out, _ = _run(capsys, folder, "--job", "job-1", "--raw")
    assert json.loads(out)["response"]["usage"]["input_tokens"] == 100


def test_no_match_and_no_folder(capsys, folder, tmp_path):
    code, out, _ = _run(capsys, folder, "--report", "nobody")
    assert code == 0 and "No matching calls." in out
    code, _, err = _run(capsys, tmp_path / "missing")
    assert code == 1 and "No debug log folder" in err
