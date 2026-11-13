"""Reading accuracy (GET /analytics/read-accuracy), the corrections fed back to the reading, and the glossary."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app import models
from app.services import glossary
from app.services.read_accuracy import (
    corrections_prompt_block,
    phrase_changes,
    recent_corrections,
)
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


def test_recent_corrections_are_per_form_unique_and_newest_first(client):
    with TestSessionLocal() as db:
        t, other = _template(db), _template(db, model="Aurora")
        _finalized(db, {"hours": 1.0}, {"hours": 1.5}, template=t, days_ago=3)
        _finalized(db, {"hours": 1.0}, {"hours": 1.25}, template=t, days_ago=2)
        _finalized(db, {"cause": "dirty"}, {"cause": "clogged nozzle"}, template=t, days_ago=1)
        _finalized(db, {"cause": "x"}, {"cause": "y"}, template=other)
        found = recent_corrections(db, t.id)
    assert found == [("cause", "dirty", "clogged nozzle"), ("hours", "1.0", "1.25")]
    block = corrections_prompt_block(found)
    assert '`cause`: read as "dirty", corrected to "clogged nozzle"' in block
    assert corrections_prompt_block([]) == ""


def test_live_extraction_prompt_carries_the_corrections(client, monkeypatch):
    from app.services import extraction

    with TestSessionLocal() as db:
        t = _template(db)
        _finalized(db, {"cause": "dirty"}, {"cause": "clogged nozzle"}, template=t)
        r = models.Report(status=models.ReportStatus.in_review, template_id=t.id, extracted_fields={})
        db.add(r)
        db.flush()
        a = models.Attachment(report_id=r.id, file_path=f"{r.id}/x.pdf", file_type="application/pdf")
        db.add(a)
        db.commit()
        assert "clogged nozzle" in extraction._learned_corrections(a, t)
        monkeypatch.setattr(extraction.settings, "learn_from_corrections", False)
        assert extraction._learned_corrections(a, t) == ""
    # A stand-in with no session gives nothing rather than failing.
    assert extraction._learned_corrections(SimpleNamespace(), t) == ""


def test_glossary_fixes_keep_case_and_whole_words():
    terms = [SimpleNamespace(wrong_term="laser direction", english_term="laser alignment", source_term="כיוון לייזר", note=None)]
    text, fixes = glossary.apply_fixes("Laser  direction done. laser direction ok. laser directions", terms)
    assert text == "Laser alignment done. laser alignment ok. laser directions"
    assert fixes == [glossary.Fix("laser direction", "laser alignment", 2)]
    assert glossary.fix_notes(fixes) == ['Glossary: "laser direction" was changed to "laser alignment" (2 times).']
    block = glossary.prompt_block(terms)
    assert '"כיוון לייזר" is "laser alignment"; never write "laser direction"' in block
    assert glossary.prompt_block([]) == ""


def test_glossary_api(client):
    assert client.post("/glossary-terms", json={"english_term": "laser alignment"}).status_code == 422
    assert client.post("/glossary-terms", json={"english_term": " ", "wrong_term": "x"}).status_code == 422
    created = client.post("/glossary-terms", json={"wrong_term": " laser   direction ", "english_term": "laser alignment"})
    assert created.status_code == 201
    term = created.json()
    assert term["wrong_term"] == "laser direction"
    patched = client.patch(f"/glossary-terms/{term['id']}", json={"source_term": "כיוון לייזר"}).json()
    assert patched["source_term"] == "כיוון לייזר"
    assert [t["english_term"] for t in client.get("/glossary-terms").json()] == ["laser alignment"]
    assert client.delete(f"/glossary-terms/{term['id']}").status_code == 204
    assert client.delete(f"/glossary-terms/{term['id']}").status_code == 404


def test_stub_translation_applies_the_glossary(client, tmp_path):
    from app.services import translation

    with TestSessionLocal() as db:
        glossary.create_term(db, None, "annual preventive maintenance", "yearly PM", None)
        r = models.Report(status=models.ReportStatus.in_review, extracted_fields={})
        db.add(r)
        db.flush()
        a = models.Attachment(report_id=r.id, file_path=f"{r.id}/hebrew.pdf", original_filename="hebrew.pdf", file_type="application/pdf")
        db.add(a)
        db.commit()
        result = translation.translate(a)
    assert "yearly PM" in result.translated_text
    assert any(n.startswith("Glossary:") for n in result.notes)


def test_glossary_validation_and_lookups(client):
    import uuid

    import pytest

    from app.services.domain_errors import InvalidError, NotFoundError

    with TestSessionLocal() as db:
        with pytest.raises(InvalidError, match="at most"):
            glossary.create_term(db, None, "x" * 121, "right", None)
        with pytest.raises(InvalidError, match="the same"):
            glossary.create_term(db, None, "Laser Alignment", "laser alignment", None)
        with pytest.raises(NotFoundError):
            glossary.update_term(db, uuid.uuid4(), {"note": "x"})
        term = glossary.create_term(db, "כיוון", None, "alignment", "a note")
        with pytest.raises(InvalidError, match="blank"):
            glossary.update_term(db, term.id, {"english_term": "  "})
    block = glossary.prompt_block([SimpleNamespace(source_term=None, wrong_term="x y", english_term="z", note="n")])
    assert '- use "z"; never write "x y" (n)' in block
    text, fixes = glossary.apply_fixes("LASER DIRECTION", [SimpleNamespace(wrong_term="laser direction", english_term="laser alignment")])
    assert text == "LASER ALIGNMENT" and fixes[0].times == 1
    assert glossary.apply_fixes("abc", [SimpleNamespace(wrong_term=None, english_term="z")]) == ("abc", [])


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


def test_live_translate_prompt_gets_the_glossary(client, monkeypatch, tmp_path):
    from app.services import translation

    seen = {}

    def fake_call(**kw):
        seen["prompt"] = kw["request_kwargs"]["messages"][0]["content"][1]["text"]
        raise translation.TranslationError("stop here")

    monkeypatch.setattr(translation, "call_claude_tool", fake_call)
    monkeypatch.setattr(translation, "claude_content_block", lambda path: {"type": "text", "text": "doc"})
    monkeypatch.setattr(translation, "_get_client", lambda: None)
    terms = [SimpleNamespace(source_term="כיוון לייזר", wrong_term="laser direction", english_term="laser alignment", note=None)]
    import pytest

    with pytest.raises(translation.TranslationError):
        translation._live_translate(SimpleNamespace(file_path=str(tmp_path / "x.pdf")), [], terms)
    assert 'never write "laser direction"' in seen["prompt"]
    result = translation.TranslationResult("he", 0.9, "Laser direction ok", [], [], [])
    fixed = translation._apply_glossary(result, terms)
    assert fixed.translated_text == "Laser alignment ok" and fixed.notes
    assert translation._apply_glossary(result._replace(translated_text="fine"), terms).notes == []
