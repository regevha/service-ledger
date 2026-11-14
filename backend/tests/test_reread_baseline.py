"""scripts/reread_baseline.py (SL-65 follow-up SL-69): a baseline from reports finalized without a first reading."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app import models
from app.services.extraction import ExtractionResult
from scripts import reread_baseline as rb
from tests.conftest import TestSessionLocal

SECRET_NAME = "Invented Technician"
SECRET_FILE = "secret-scan-name.pdf"
SECRET_VALUE = "value-that-must-not-print"


def _report(db, template, kept, *, minutes_ago=0, first_reading=None, with_file=True):
    extra = {"original_fields": first_reading} if first_reading is not None else {}  # a JSONB None would be JSON null
    r = models.Report(
        status=models.ReportStatus.finalized,
        finalized_at=datetime.now(timezone.utc) - timedelta(minutes=minutes_ago),
        extracted_fields=kept,
        template_id=template.id,
        technician_name=SECRET_NAME,
        **extra,
    )
    db.add(r)
    db.flush()
    if with_file:
        db.add(models.Attachment(report_id=r.id, file_path=f"{r.id}/{SECRET_FILE}", file_type="application/pdf"))
    db.commit()
    db.refresh(r)
    return r


@pytest.fixture
def template():
    with TestSessionLocal() as db:
        t = models.ReportTemplate(instrument_type="facs", report_type=models.ReportType.repair, model="Test", field_schema={"fields": []})
        db.add(t)
        db.commit()
        db.refresh(t)
        yield t


@pytest.fixture
def use_test_db(monkeypatch):
    monkeypatch.setattr(rb, "SessionLocal", TestSessionLocal)


def _answer(values, confidences):
    return lambda attachment, template: ExtractionResult(values, confidences, None)


def test_only_reports_without_a_first_reading_are_listed_newest_first(template):
    with TestSessionLocal() as db:
        old = _report(db, template, {"a": "1"}, minutes_ago=30)
        new = _report(db, template, {"a": "1"}, minutes_ago=5)
        _report(db, template, {"a": "1"}, first_reading={"a": "1"})
        assert [r.id for r in rb.unmeasured_reports(db)] == [new.id, old.id]


def test_dry_run_counts_and_makes_no_call(template, use_test_db, monkeypatch, capsys):
    def boom(*a):
        raise AssertionError("a dry run must not read anything")

    monkeypatch.setattr(rb, "extract", boom)
    with TestSessionLocal() as db:
        _report(db, template, {"a": "1"})
        _report(db, template, {"a": "1"}, first_reading={"a": "1"})
    assert rb.main([]) == 0
    out = capsys.readouterr().out
    assert "with a first reading (measured by the accuracy page): 1" in out
    assert "without one: 1" in out and "1 Claude calls" in out


def test_run_scores_against_the_approved_values(template, use_test_db, monkeypatch, capsys):
    monkeypatch.setattr(
        rb, "extract",
        _answer({"a": "1", "b": SECRET_VALUE, "c": "3", "d": ""}, {"a": 0.95, "b": 0.5, "c": 0.8, "d": 0.9}),
    )
    with TestSessionLocal() as db:
        _report(db, template, {"a": "1", "b": "other", "c": "3", "d": "typed"})
    assert rb.main(["--run"]) == 0
    out = capsys.readouterr().out
    assert "Re-read 1 reports (0 skipped" in out
    assert "Fields read 3; same as the approved value 2 (66.7%)" in out  # the empty "d" is not counted
    assert "below_0.70: 1 fields, 0 same" in out and "0.70_to_0.85: 1 fields, 1 same" in out and "0.85_and_up: 1 fields, 1 same" in out
    assert out.index("  b: ") < out.index("  a: ")  # worst field first


def test_output_holds_no_value_name_or_file_name(template, use_test_db, monkeypatch, capsys):
    monkeypatch.setattr(rb, "extract", _answer({"a": SECRET_VALUE}, {"a": 0.9}))
    with TestSessionLocal() as db:
        _report(db, template, {"a": "something else"})
    rb.main(["--run"])
    captured = capsys.readouterr()
    for text in (SECRET_VALUE, "something else", SECRET_NAME, SECRET_FILE, "pdf"):
        assert text not in captured.out + captured.err


def test_an_unreadable_report_is_skipped_and_the_run_goes_on(template, use_test_db, monkeypatch, capsys):
    calls = []

    def flaky(attachment, tpl):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError(f"cannot open /data/{SECRET_FILE}")
        return ExtractionResult({"a": "1"}, {"a": 0.9}, None)

    monkeypatch.setattr(rb, "extract", flaky)
    with TestSessionLocal() as db:
        _report(db, template, {"a": "1"}, minutes_ago=1)
        _report(db, template, {"a": "1"}, minutes_ago=2)
        _report(db, template, {"a": "1"}, minutes_ago=3, with_file=False)  # no document: skipped, not read
    rb.main(["--run"])
    out = capsys.readouterr().out
    assert "Re-read 1 reports (2 skipped" in out
    assert "no document x1" in out and "RuntimeError x1" in out
    assert SECRET_FILE not in out and "/data" not in out


def test_limit_is_respected_and_capped(template, use_test_db, monkeypatch, capsys):
    monkeypatch.setattr(rb, "extract", _answer({"a": "1"}, {"a": 0.9}))
    with TestSessionLocal() as db:
        for i in range(3):
            _report(db, template, {"a": "1"}, minutes_ago=i)
    rb.main(["--run", "--limit", "2"])
    assert "Re-read 2 reports" in capsys.readouterr().out
    rb.main(["--limit", "1000"])
    assert f"--limit {rb.MAX_PER_RUN}" in capsys.readouterr().out


def test_a_run_with_nothing_to_read(use_test_db, monkeypatch, capsys):
    monkeypatch.setattr(rb, "extract", _answer({}, {}))
    assert rb.main(["--run"]) == 0
    assert "Re-read 0 reports" in capsys.readouterr().out


def test_the_apps_log_lines_with_file_names_do_not_reach_the_terminal(template, use_test_db, monkeypatch, capsys, caplog):
    import logging

    def failing(attachment, tpl):
        logging.getLogger("app.services.claude_client").exception("failed extracting attachment %s", SECRET_FILE)
        raise RuntimeError("refused")

    monkeypatch.setattr(rb, "extract", failing)
    with TestSessionLocal() as db:
        _report(db, template, {"a": "1"})
    with caplog.at_level(logging.DEBUG):
        rb.main(["--run"])
    assert SECRET_FILE not in capsys.readouterr().err + caplog.text
    assert logging.getLogger().manager.disable == logging.NOTSET  # logging is back on afterwards


def test_a_skip_shows_the_error_class_and_its_cause_but_never_the_message(template, use_test_db, monkeypatch, capsys):
    def refused(attachment, tpl):
        try:
            raise ValueError(f"401 for {SECRET_FILE}")
        except ValueError as cause:
            raise LookupError(f"failed extracting {SECRET_FILE}") from cause

    monkeypatch.setattr(rb, "extract", refused)
    with TestSessionLocal() as db:
        _report(db, template, {"a": "1"})
    rb.main(["--run"])
    out = capsys.readouterr().out
    assert "LookupError <- ValueError x1" in out and SECRET_FILE not in out


@pytest.fixture
def live(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(rb, "get_settings", lambda: SimpleNamespace(use_live_claude=True))


def test_save_stores_the_re_read_as_the_first_reading_and_marks_it(template, use_test_db, live, monkeypatch, capsys):
    monkeypatch.setattr(rb, "extract", _answer({"a": "1", "b": "2"}, {"a": 0.9, "b": 0.6}))
    with TestSessionLocal() as db:
        r = _report(db, template, {"a": "1", "b": "other"})
    assert rb.main(["--run", "--save"]) == 0
    assert "Saved 1 re-reads" in capsys.readouterr().out
    with TestSessionLocal() as db:
        saved = db.get(models.Report, r.id)
        assert saved.original_fields == {"a": "1", "b": "2"} and saved.extracted_fields == {"a": "1", "b": "other"}
        [job] = db.query(models.ExtractionJob).all()
        assert job.params["baseline"] == "reread" and len(job.params["prompt_hash"]) == 12
        assert job.field_confidences == {"a": 0.9, "b": 0.6}
        assert job.status == models.ExtractionJobStatus.succeeded
    with TestSessionLocal() as db:
        assert rb.unmeasured_reports(db) == []


def test_a_run_without_save_stores_nothing(template, use_test_db, live, monkeypatch, capsys):
    monkeypatch.setattr(rb, "extract", _answer({"a": "1"}, {"a": 0.9}))
    with TestSessionLocal() as db:
        r = _report(db, template, {"a": "1"})
    rb.main(["--run"])
    assert "Nothing was stored" in capsys.readouterr().out
    with TestSessionLocal() as db:
        assert db.get(models.Report, r.id).original_fields is None
        assert db.query(models.ExtractionJob).count() == 0


def test_save_is_refused_for_a_stub_reading(template, use_test_db, monkeypatch, capsys):
    monkeypatch.setattr(rb, "extract", _answer({"a": "invented"}, {"a": 0.9}))
    with TestSessionLocal() as db:
        r = _report(db, template, {"a": "1"})
    assert rb.main(["--run", "--save"]) == 2
    assert "must not be stored" in capsys.readouterr().err
    with TestSessionLocal() as db:
        assert db.get(models.Report, r.id).original_fields is None


def test_save_never_replaces_an_existing_first_reading(template, use_test_db, live):
    with TestSessionLocal() as db:
        r = _report(db, template, {"a": "1"})
        reading = rb.Reading([("a", True, 0.9)], {"a": "new"}, {"a": 0.9}, db.query(models.Attachment).first().id)
        r.original_fields = {"a": "first"}
        db.commit()
        assert rb.save_reading(db, r, reading) is False
        assert db.get(models.Report, r.id).original_fields == {"a": "first"}
        assert db.query(models.ExtractionJob).count() == 0


def test_save_needs_run(use_test_db):
    with pytest.raises(SystemExit):
        rb.main(["--save"])
