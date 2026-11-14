"""Reading accuracy (GET /analytics/read-accuracy)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app import models
from app.services.read_accuracy import phrase_changes
from tests.conftest import TestSessionLocal


def _now():
    return datetime.now(timezone.utc)


def _template(db, model="FACSAria III"):
    t = models.ReportTemplate(instrument_type="facs", report_type=models.ReportType.repair, model=model, field_schema={"fields": []})
    db.add(t)
    db.commit()
    return t


def _finalized(db, original, kept, *, template=None, days_ago=0, translation=None):
    r = models.Report(
        status=models.ReportStatus.finalized,
        finalized_at=_now() - timedelta(days=days_ago),
        original_fields=original,
        extracted_fields=kept,
        template_id=template.id if template else None,
    )
    db.add(r)
    db.flush()
    if translation is not None:
        a = models.Attachment(report_id=r.id, file_path=f"{r.id}/x.pdf", file_type="application/pdf")
        db.add(a)
        db.flush()
        model_text, accepted = translation
        db.add(
            models.Translation(
                attachment_id=a.id,
                status=models.TranslationStatus.accepted,
                source_language="he",
                model_text=model_text,
                accepted_text=accepted,
            )
        )
    db.commit()
    return r


def test_empty_database(client):
    body = client.get("/analytics/read-accuracy").json()
    assert body["fields"] == 0 and body["reports"] == 0 and body["goal"] == 0.99
    assert body["weeks"] == [] and body["corrections"] == []


def test_counts_fields_reports_and_lists_corrections(client):
    with TestSessionLocal() as db:
        t = _template(db)
        _finalized(db, {"a": "1", "b": "x", "c": ""}, {"a": "1", "b": "x", "c": "typed"}, template=t)
        _finalized(db, {"a": "1", "b": "laser direction"}, {"a": "1", "b": "laser alignment"}, template=t)
        # Draft and pre-tracking reports are left out.
        db.add(models.Report(status=models.ReportStatus.in_review, original_fields={"a": "1"}, extracted_fields={"a": "2"}))
        db.add(models.Report(status=models.ReportStatus.finalized, finalized_at=_now(), extracted_fields={"a": "2"}))
        db.commit()
    body = client.get("/analytics/read-accuracy").json()
    assert (body["fields"], body["unchanged"]) == (4, 3)
    assert (body["reports"], body["reports_untouched"]) == (2, 1)
    assert body["by_field"][0] == {"field": "b", "fields": 2, "unchanged": 1}
    assert body["by_form"][0]["form"] == "Repair, FACSAria III"
    [c] = body["corrections"]
    assert (c["field"], c["read"], c["kept"]) == ("b", "laser direction", "laser alignment")
    assert sum(w["fields"] for w in body["weeks"]) == 4


def test_days_window_and_all(client):
    with TestSessionLocal() as db:
        _finalized(db, {"a": "1"}, {"a": "2"}, days_ago=200)
        _finalized(db, {"a": "1"}, {"a": "1"})
    assert client.get("/analytics/read-accuracy").json()["fields"] == 1
    assert client.get("/analytics/read-accuracy?days=0").json()["fields"] == 2


def test_translated_reports_and_translation_edits(client):
    with TestSessionLocal() as db:
        _finalized(db, {"a": "1"}, {"a": "1"}, translation=("Laser direction checked", "Laser alignment checked"))
        _finalized(db, {"a": "1"}, {"a": "1"}, translation=("All good", None))
        _finalized(db, {"a": "1"}, {"a": "2"})
    body = client.get("/analytics/read-accuracy").json()
    sources = {s["source"]: s for s in body["by_source"]}
    assert sources["translated"]["untouched"] == 2 and sources["original"]["untouched"] == 0
    assert (body["translations"]["accepted"], body["translations"]["unchanged"]) == (2, 1)
    [edit] = body["translations"]["edits"]
    assert edit["changes"] == [{"before": "Laser direction", "after": "Laser alignment"}]


def test_phrase_changes():
    assert phrase_changes("a b c d", "a x c d") == [("a b", "a x")]
    assert phrase_changes("b c", "x c") == [("b", "x")]
    assert phrase_changes("a b c d", "a x y d") == [("b c", "x y")]
    assert phrase_changes("a b", "a b c") == [("", "c")]














def test_values_are_shown_as_one_short_line():
    from app.services.read_accuracy import MAX_SHOWN, _show

    assert _show(None) == ""
    assert _show(True) == "yes" and _show(False) == "no"
    assert _show([{"part": "valve", "qty": 1}]) == '[{"part": "valve", "qty": 1}]'
    assert _show("a\n  b") == "a b"
    long = _show("x" * 500)
    assert len(long) == MAX_SHOWN and long.endswith("…")


def test_report_names_in_the_corrections_list(client):
    with TestSessionLocal() as db:
        instrument = models.Instrument(name="Lab Aria", model="FACSAria III", serial_number=f"SN-{datetime.now().timestamp()}", manufacturer="BD")
        db.add(instrument)
        db.flush()
        r = _finalized(db, {"a": "1"}, {"a": "2"})
        r.instrument_id = instrument.id
        db.commit()
    [c] = client.get("/analytics/read-accuracy").json()["corrections"]
    assert c["instrument"] == "Lab Aria (FACSAria III)" and c["form"] == "No form"




def _read_job(db, report, *, confidences, params=None, minutes_ago=0):
    a = models.Attachment(report_id=report.id, file_path=f"{report.id}/r.pdf", file_type="application/pdf")
    db.add(a)
    db.flush()
    db.add(
        models.ExtractionJob(
            attachment_id=a.id,
            kind=models.ExtractionJobKind.extract,
            status=models.ExtractionJobStatus.succeeded,
            field_confidences=confidences,
            params=params,
            completed_at=_now() - timedelta(minutes=minutes_ago),
        )
    )
    db.commit()


def test_fields_filled_by_hand_are_counted_apart(client):
    with TestSessionLocal() as db:
        _finalized(db, {"a": "1", "b": "", "c": None}, {"a": "1", "b": "typed", "c": ""})
    body = client.get("/analytics/read-accuracy").json()
    assert body["filled_by_hand"] == {"empty": 2, "filled": 1}
    # What the reading left empty is not part of the percentage.
    assert (body["fields"], body["unchanged"]) == (1, 1)


def test_share_kept_per_confidence_band(client):
    with TestSessionLocal() as db:
        r = _finalized(db, {"a": "1", "b": "2", "c": "3", "d": "4"}, {"a": "1", "b": "x", "c": "3", "d": "4"})
        _read_job(db, r, confidences={"a": 0.5, "b": 0.69, "c": 0.7, "d": 0.95, "e": 0.99})
    bands = {b["band"]: (b["fields"], b["unchanged"]) for b in client.get("/analytics/read-accuracy").json()["by_confidence"]}
    assert bands == {"below_0.70": (2, 1), "0.70_to_0.85": (1, 1), "0.85_and_up": (1, 1)}


def test_report_without_a_read_job_is_in_no_band(client):
    with TestSessionLocal() as db:
        _finalized(db, {"a": "1"}, {"a": "1"})
    body = client.get("/analytics/read-accuracy").json()
    assert all(b["fields"] == 0 for b in body["by_confidence"])
    assert [(p["prompt_hash"], p["model"], p["fields"]) for p in body["by_prompt"]] == [("unknown", "unknown", 1)]


def test_share_kept_per_prompt_uses_the_latest_read(client):
    with TestSessionLocal() as db:
        old = {"prompt_hash": "aaa111", "model": "m1"}
        new = {"prompt_hash": "bbb222", "model": "m2"}
        r1 = _finalized(db, {"a": "1"}, {"a": "1"})
        _read_job(db, r1, confidences={"a": 0.9}, params=old, minutes_ago=30)
        _read_job(db, r1, confidences={"a": 0.9}, params=new, minutes_ago=5)
        r2 = _finalized(db, {"a": "1", "b": "2"}, {"a": "1", "b": "9"})
        _read_job(db, r2, confidences={"a": 0.9, "b": 0.9}, params=new)
    rows = {(p["prompt_hash"], p["model"]): (p["fields"], p["unchanged"], p["reports"]) for p in client.get("/analytics/read-accuracy").json()["by_prompt"]}
    assert rows == {("bbb222", "m2"): (3, 2, 2)}


def test_home_figure_equals_page_figure(client):
    with TestSessionLocal() as db:
        _finalized(db, {"a": "1", "b": "2"}, {"a": "1", "b": "9"}, days_ago=3)
        _finalized(db, {"a": "1"}, {"a": "1"}, days_ago=10)
        _finalized(db, {"a": "1"}, {"a": "2"}, days_ago=45)  # outside both windows
    home = client.get("/home/summary").json()["read_without_edits"]
    page = client.get("/analytics/read-accuracy?days=30").json()
    assert (home["reports"], home["fields"], home["unchanged"]) == (page["reports"], page["fields"], page["unchanged"]) == (2, 3, 2)
