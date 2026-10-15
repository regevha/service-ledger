"""Hebrew translation (docs: claude/proposal-hebrew-translation.md).

Covers the translate job, the review states (accept, edit, discard, translate
again), the rule that classification and extraction wait for an accepted
translation, QC printout pages being ignored, the no-key refusal, and the live
path with only the Anthropic client faked.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import models
from app.services import classification, extraction, translation
from app.services.translation import hebrew_share, identifier_check, identifiers_in


# ---------- helpers ----------


def _upload(client, filename: str, body: bytes = b"%PDF-1.4 fake scan") -> dict:
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": (filename, body, "application/pdf")},
    )
    assert upload.status_code == 201, upload.text
    return {"report": report, "attachment": upload.json()}


def _translate(client, run_worker, attachment_id: str, include_pages: list[int] | None = None) -> dict:
    body = {"include_pages": include_pages} if include_pages else None
    resp = client.post(f"/attachments/{attachment_id}/translate", json=body)
    assert resp.status_code == 202, resp.text
    run_worker()
    return client.get(f"/extraction-jobs/{resp.json()['id']}").json()


def _current(client, attachment_id: str) -> dict:
    resp = client.get(f"/attachments/{attachment_id}/translation")
    assert resp.status_code == 200, resp.text
    return resp.json()


class _FakeMessages:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._responses.pop(0) if len(self._responses) > 1 else self._responses[0]


class _FakeClient:
    def __init__(self, *responses):
        self.messages = _FakeMessages(responses)


def _tool_use(input_dict: dict, stop_reason: str = "tool_use"):
    return SimpleNamespace(content=[SimpleNamespace(type="tool_use", input=input_dict)], stop_reason=stop_reason)


def _translation_input(**overrides) -> dict:
    data = {
        "source_language": "he",
        "hebrew_share": 0.7,
        "translated_text": "Report 2046 | S.N Y1033 | Order 4010348 | 13.08.2026",
        "ignored_pages": [{"page": 2, "reason": "Daily QC report"}, {"page": 3, "reason": "Daily QC report"}],
        "identifiers": ["2046", "Y1033", "4010348", "13.08.2026"],
        "notes": [],
    }
    data.update(overrides)
    return data


@pytest.fixture()
def live(monkeypatch):
    """Switch every service to the live path; the tests install fake clients."""
    monkeypatch.setattr(translation.settings, "use_live_claude", True)  # one shared Settings object
    return monkeypatch


# ---------- pure helpers ----------


def test_hebrew_share_counts_letters_only():
    assert hebrew_share("") == 0.0
    assert hebrew_share("12345 - /") == 0.0
    assert hebrew_share("hello") == 0.0
    assert hebrew_share("שלום") == 1.0
    assert hebrew_share("שלום ab") == pytest.approx(2 / 3)  # "שלום" is 4 letters, "ab" 2 -> 4/6


def test_identifiers_are_tokens_with_digits():
    found = identifiers_in("Report SC26R006240 for BE50173, call 22/09/26 of Cytek Aurora, hello")
    assert "SC26R006240" in found and "BE50173" in found
    assert "hello" not in found and "Cytek" not in found


def test_identifier_check_reports_the_ones_missing_from_the_translation():
    check = identifier_check(["Y1033", "N7-97566"], "S.N Y1033 only", original_text="BE50173")
    assert check["checked"] == 3
    assert check["missing"] == ["N7-97566", "BE50173"]


# ---------- stub mode: the review flow ----------


def test_a_document_that_is_not_hebrew_needs_no_review(client, run_worker):
    ids = _upload(client, "aria_pm_2026.pdf")
    att = ids["attachment"]["id"]
    job = _translate(client, run_worker, att)
    assert job["status"] == "succeeded" and job["kind"] == "translate"

    current = _current(client, att)
    assert current["status"] == "not_needed"
    assert current["model_text"] is None

    # No gate: classify goes through as it always did.
    assert client.post(f"/attachments/{att}/classify").status_code == 202


def test_a_hebrew_document_waits_for_review_and_blocks_classify_and_extract(client, run_worker):
    ids = _upload(client, "hebrew_cytek_report.pdf")
    att = ids["attachment"]["id"]
    _translate(client, run_worker, att)

    current = _current(client, att)
    assert current["status"] == "pending_review"
    assert current["model_text"] and current["accepted_text"] is None
    assert current["source_language"] == "he"
    # QC printouts are ignored, and the original is untouched and still downloadable.
    assert [p["page"] for p in current["ignored_pages"]] == [2, 3]
    assert client.get(f"/attachments/{att}/file").status_code == 200

    blocked = client.post(f"/attachments/{att}/classify")
    assert blocked.status_code == 409 and "waiting for review" in blocked.json()["detail"]
    assert client.post(f"/attachments/{att}/extract").status_code == 409

    report = client.get(f"/reports/{ids['report']['id']}").json()
    assert report["attachments"][0]["translation_status"] == "pending_review"


def test_accepting_unlocks_classification_and_keeps_both_texts(client, run_worker):
    ids = _upload(client, "hebrew_cytek_report.pdf")
    att = ids["attachment"]["id"]
    _translate(client, run_worker, att)
    tid = _current(client, att)["id"]

    accepted = client.post(f"/translations/{tid}/accept", json={"accepted_text": "Edited English text, S.N Y1033"})
    assert accepted.status_code == 200
    body = accepted.json()
    assert body["status"] == "accepted"
    assert body["accepted_text"] == "Edited English text, S.N Y1033"
    assert body["model_text"] != body["accepted_text"]  # the model's text is kept as it was
    assert body["accepted_at"] is not None

    assert client.post(f"/attachments/{att}/classify").status_code == 202


def test_accept_without_text_accepts_the_models_text(client, run_worker):
    att = _upload(client, "hebrew_a.pdf")["attachment"]["id"]
    _translate(client, run_worker, att)
    current = _current(client, att)
    body = client.post(f"/translations/{current['id']}/accept").json()
    assert body["accepted_text"] == current["model_text"]


def test_a_translation_can_only_be_accepted_once_and_not_blank(client, run_worker):
    att = _upload(client, "hebrew_a.pdf")["attachment"]["id"]
    _translate(client, run_worker, att)
    tid = _current(client, att)["id"]
    assert client.post(f"/translations/{tid}/accept", json={"accepted_text": "   "}).status_code == 422
    assert client.post(f"/translations/{tid}/accept").status_code == 200
    again = client.post(f"/translations/{tid}/accept")
    assert again.status_code == 409


def test_discard_goes_back_to_the_original_flow(client, run_worker):
    att = _upload(client, "hebrew_a.pdf")["attachment"]["id"]
    _translate(client, run_worker, att)
    tid = _current(client, att)["id"]
    assert client.post(f"/translations/{tid}/discard").json()["status"] == "discarded"
    assert client.post(f"/attachments/{att}/classify").status_code == 202  # as today, on the original
    assert client.post(f"/translations/{tid}/discard").status_code == 409  # already discarded


def test_translating_again_keeps_the_earlier_one_as_history(client, run_worker):
    att = _upload(client, "hebrew_a.pdf")["attachment"]["id"]
    _translate(client, run_worker, att)
    first = _current(client, att)
    client.post(f"/translations/{first['id']}/accept")

    _translate(client, run_worker, att)
    second = _current(client, att)
    assert second["id"] != first["id"] and second["status"] == "pending_review"

    history = client.get(f"/attachments/{att}/translations").json()
    assert [t["id"] for t in history] == [second["id"], first["id"]]
    assert history[1]["status"] == "superseded"
    # The superseded translation can no longer be accepted or discarded.
    assert client.post(f"/translations/{first['id']}/accept").status_code == 409
    # And the new one blocks classification again until it is reviewed.
    assert client.post(f"/attachments/{att}/classify").status_code == 409


def test_a_qc_page_can_be_included_for_one_report(client, run_worker):
    att = _upload(client, "hebrew_a.pdf")["attachment"]["id"]
    _translate(client, run_worker, att)
    assert [p["page"] for p in _current(client, att)["ignored_pages"]] == [2, 3]

    _translate(client, run_worker, att, include_pages=[2])
    current = _current(client, att)
    assert [p["page"] for p in current["ignored_pages"]] == [3]
    assert current["included_pages"] == [2]
    assert "Page 2 included" in current["model_text"]


def test_include_pages_must_start_at_one(client):
    att = _upload(client, "hebrew_a.pdf")["attachment"]["id"]
    assert client.post(f"/attachments/{att}/translate", json={"include_pages": [0]}).status_code == 422


def test_only_one_translation_at_a_time_and_unknown_ids(client):
    att = _upload(client, "hebrew_a.pdf")["attachment"]["id"]
    assert client.post(f"/attachments/{att}/translate").status_code == 202
    assert client.post(f"/attachments/{att}/translate").status_code == 409
    # While it is pending, classify waits too.
    assert client.post(f"/attachments/{att}/classify").status_code == 409
    missing = "00000000-0000-0000-0000-000000000000"
    assert client.post(f"/attachments/{missing}/translate").status_code == 404
    assert client.get(f"/attachments/{missing}/translation").status_code == 404
    assert client.post(f"/translations/{missing}/accept").status_code == 404
    assert client.get(f"/attachments/{att}/translation").status_code == 404  # none yet


def test_a_finalized_report_cannot_be_translated_or_its_translation_changed(client, run_worker, db_session):
    ids = _upload(client, "hebrew_a.pdf")
    att = ids["attachment"]["id"]
    _translate(client, run_worker, att)
    tid = _current(client, att)["id"]

    report = db_session.get(models.Report, ids["report"]["id"])
    report.status = models.ReportStatus.finalized
    db_session.commit()

    assert client.post(f"/attachments/{att}/translate").status_code == 409
    assert client.post(f"/translations/{tid}/accept").status_code == 409
    assert client.post(f"/translations/{tid}/discard").status_code == 409


def test_there_is_no_route_that_serves_the_translation_as_a_file():
    from app.main import app

    paths = [path for path in app.openapi()["paths"] if "translation" in path]
    assert paths  # the review routes exist
    assert not [p for p in paths if "file" in p or "download" in p or "pdf" in p]


def test_deleting_a_report_removes_its_translations(client, run_worker, db_session):
    ids = _upload(client, "hebrew_a.pdf")
    att = ids["attachment"]["id"]
    _translate(client, run_worker, att)
    assert db_session.query(models.Translation).count() == 1
    assert client.delete(f"/reports/{ids['report']['id']}").status_code == 204
    db_session.expire_all()
    assert db_session.query(models.Translation).count() == 0


def test_a_translate_job_in_flight_blocks_deleting_the_report(client):
    ids = _upload(client, "hebrew_a.pdf")
    assert client.post(f"/attachments/{ids['attachment']['id']}/translate").status_code == 202
    assert client.delete(f"/reports/{ids['report']['id']}").status_code == 409


def test_worker_recovery_fails_a_job_left_translating(db_session, client):
    from app.worker import _recover_orphaned_jobs

    att = _upload(client, "hebrew_a.pdf")["attachment"]["id"]
    job_id = client.post(f"/attachments/{att}/translate").json()["id"]
    job = db_session.get(models.ExtractionJob, job_id)
    job.status = models.ExtractionJobStatus.translating
    db_session.commit()
    assert _recover_orphaned_jobs(db_session) == 1
    db_session.refresh(job)
    assert job.status == models.ExtractionJobStatus.failed


# ---------- no API key ----------


def test_a_hebrew_text_layer_is_refused_without_a_key_and_blocks_classify(client, run_worker, monkeypatch):
    monkeypatch.setattr(translation, "text_layer_hebrew_share", lambda attachment: 0.9)
    att = _upload(client, "scan.pdf")["attachment"]["id"]

    # Never passed on silently: classify and extract wait for a translation.
    blocked = client.post(f"/attachments/{att}/classify")
    assert blocked.status_code == 409 and "Hebrew" in blocked.json()["detail"]

    job = _translate(client, run_worker, att)
    assert job["status"] == "failed"
    assert "Claude API key" in job["error_message"]
    assert client.get(f"/attachments/{att}/translation").status_code == 404


# ---------- live path (client faked) ----------


def test_live_translation_sends_the_page_and_ignores_qc_pages(client, run_worker, live):
    fake = _FakeClient(_tool_use(_translation_input()))
    live.setattr(translation, "_get_client", lambda: fake)
    ids = _upload(client, "cytek_report.pdf")
    att = ids["attachment"]["id"]

    job = _translate(client, run_worker, att)
    assert job["status"] == "succeeded"

    assert len(fake.messages.calls) == 1
    call = fake.messages.calls[0]
    content = call["messages"][0]["content"]
    assert content[0]["type"] == "document"  # the page itself, not extracted text
    assert "IGNORE instrument QC printouts" in content[1]["text"]
    assert call["max_tokens"] == 16000
    assert call["tool_choice"] == {"type": "tool", "name": "record_translation"}

    current = _current(client, att)
    assert current["status"] == "pending_review" and current["reader"] == "model"
    assert current["hebrew_share"] == pytest.approx(0.7)
    assert [p["page"] for p in current["ignored_pages"]] == [2, 3]
    assert current["identifier_check"] == {"checked": 4, "missing": []}


def test_live_translation_flags_identifiers_that_did_not_survive(client, run_worker, live):
    text = "Report 2046 | S.N Y1033"  # the order number and the date are gone
    fake = _FakeClient(_tool_use(_translation_input(translated_text=text)))
    live.setattr(translation, "_get_client", lambda: fake)
    att = _upload(client, "cytek_report.pdf")["attachment"]["id"]
    _translate(client, run_worker, att)
    assert _current(client, att)["identifier_check"]["missing"] == ["4010348", "13.08.2026"]


def test_live_including_a_page_asks_the_model_and_drops_it_from_the_ignored_list(client, run_worker, live):
    fake = _FakeClient(_tool_use(_translation_input()))  # the model still lists 2 and 3
    live.setattr(translation, "_get_client", lambda: fake)
    att = _upload(client, "cytek_report.pdf")["attachment"]["id"]
    _translate(client, run_worker, att, include_pages=[2])
    prompt = fake.messages.calls[0]["messages"][0]["content"][1]["text"]
    assert "page(s) 2 to be translated" in prompt
    current = _current(client, att)
    assert [p["page"] for p in current["ignored_pages"]] == [3]
    assert current["included_pages"] == [2]


def test_live_english_document_needs_no_review(client, run_worker, live):
    fake = _FakeClient(_tool_use(_translation_input(source_language="en", hebrew_share=0.0, ignored_pages=[])))
    live.setattr(translation, "_get_client", lambda: fake)
    att = _upload(client, "english_scan.pdf")["attachment"]["id"]
    _translate(client, run_worker, att)
    assert _current(client, att)["status"] == "not_needed"
    assert client.post(f"/attachments/{att}/classify").status_code == 202


def test_live_a_text_layer_that_is_not_hebrew_makes_no_model_call(client, run_worker, live):
    fake = _FakeClient(_tool_use(_translation_input()))
    live.setattr(translation, "_get_client", lambda: fake)
    live.setattr(translation, "text_layer_hebrew_share", lambda attachment: 0.0)
    att = _upload(client, "english_text.pdf")["attachment"]["id"]
    _translate(client, run_worker, att)
    assert fake.messages.calls == []
    assert _current(client, att)["status"] == "not_needed"


def test_live_a_cut_off_translation_is_not_saved(client, run_worker, live):
    fake = _FakeClient(_tool_use(_translation_input(), stop_reason="max_tokens"))
    live.setattr(translation, "_get_client", lambda: fake)
    att = _upload(client, "cytek_report.pdf")["attachment"]["id"]
    job = _translate(client, run_worker, att)
    assert job["status"] == "failed" and "cut off" in job["error_message"]
    assert client.get(f"/attachments/{att}/translation").status_code == 404


def test_live_malformed_translation_fails_the_job(client, run_worker, live):
    fake = _FakeClient(_tool_use({"source_language": "he"}))
    live.setattr(translation, "_get_client", lambda: fake)
    att = _upload(client, "cytek_report.pdf")["attachment"]["id"]
    job = _translate(client, run_worker, att)
    assert job["status"] == "failed" and "malformed" in job["error_message"]


def test_classification_and_extraction_read_the_accepted_english(client, run_worker, live):
    translate_client = _FakeClient(_tool_use(_translation_input()))
    live.setattr(translation, "_get_client", lambda: translate_client)
    classify_client = _FakeClient(
        _tool_use(
            {
                "instrument_model": "LSRFortessa",
                "instrument_confidence": 0.95,
                "report_type": "repair",
                "report_type_confidence": 0.92,
            }
        )
    )
    live.setattr(classification, "_get_client", lambda: classify_client)

    ids = _upload(client, "cytek_report.pdf")
    att = ids["attachment"]["id"]
    _translate(client, run_worker, att)
    tid = _current(client, att)["id"]
    client.post(f"/translations/{tid}/accept", json={"accepted_text": "Accepted English: S.N Y1033"})

    assert client.post(f"/attachments/{att}/classify").status_code == 202
    run_worker()
    sent = classify_client.messages.calls[0]["messages"][0]["content"]
    assert sent[0]["type"] == "text"  # not the original document
    assert "Accepted English: S.N Y1033" in sent[0]["text"]
    assert "<document>" in sent[0]["text"]

    # Extraction too.
    report = client.get(f"/reports/{ids['report']['id']}").json()
    assert report["template_id"]
    extract_client = _FakeClient(_tool_use({}))
    live.setattr(extraction, "_get_client", lambda: extract_client)
    assert client.post(f"/attachments/{att}/extract").status_code == 202
    run_worker()
    sent = extract_client.messages.calls[0]["messages"][0]["content"]
    assert sent[0]["type"] == "text" and "Accepted English" in sent[0]["text"]
    assert "HH:MM" in sent[1]["text"]  # the duration rule is in the extraction prompt


def test_a_discarded_translation_means_the_original_is_sent(client, run_worker, live):
    live.setattr(translation, "_get_client", lambda: _FakeClient(_tool_use(_translation_input())))
    classify_client = _FakeClient(
        _tool_use(
            {
                "instrument_model": "LSRFortessa",
                "instrument_confidence": 0.95,
                "report_type": "repair",
                "report_type_confidence": 0.92,
            }
        )
    )
    live.setattr(classification, "_get_client", lambda: classify_client)
    att = _upload(client, "cytek_report.pdf")["attachment"]["id"]
    _translate(client, run_worker, att)
    client.post(f"/translations/{_current(client, att)['id']}/discard")
    client.post(f"/attachments/{att}/classify")
    run_worker()
    assert classify_client.messages.calls[0]["messages"][0]["content"][0]["type"] == "document"


# ---------- classification of a document from another company ----------


def _classify_live(client, run_worker, live, tool_input: dict, filename="other_company.pdf"):
    fake = _FakeClient(_tool_use(tool_input))
    live.setattr(classification, "_get_client", lambda: fake)
    ids = _upload(client, filename)
    att = ids["attachment"]["id"]
    job_id = client.post(f"/attachments/{att}/classify").json()["id"]
    run_worker()
    return ids, client.get(f"/extraction-jobs/{job_id}").json(), fake


def test_an_instrument_not_in_the_fleet_is_not_forced_into_the_nearest_model(client, run_worker, live):
    ids, job, fake = _classify_live(
        client,
        run_worker,
        live,
        {
            "instrument_model": "(not in the fleet)",
            "instrument_confidence": 0.9,
            "report_type": "installation_upgrade",
            "report_type_confidence": 0.9,
            "instrument_serial": "Y1033",
            "instrument_serial_confidence": 0.95,
            "task_code": "",
            "task_code_confidence": 0,
            "work_order_number": "2046",
            "issuer": "almog diagnostic",
            "detected_manufacturer": "Cytek Biosciences",
            "report_type_note": "also an annual preventive maintenance visit",
        },
    )
    assert job["status"] == "succeeded"
    result = job["classification"]
    assert result["maker_in_fleet"] is False
    assert result["detected_manufacturer"] == "Cytek Biosciences"
    assert result["instrument"]["confidence"] == 0.0  # a placeholder, so the technician picks
    assert result["resolved_template_id"] is None and result["resolved_instrument_id"] is None
    assert result["issuer"] == "almog diagnostic"
    # The sentinel is offered to the model as a choice.
    tool = fake.messages.calls[0]["tools"][0]
    assert "(not in the fleet)" in tool["input_schema"]["properties"]["instrument_model"]["enum"]
    assert "never pick the nearest model" in fake.messages.calls[0]["messages"][0]["content"][1]["text"]

    report = client.get(f"/reports/{ids['report']['id']}").json()
    assert report["issuer"] == "almog diagnostic"
    assert report["report_type_note"] == "also an annual preventive maintenance visit"


def test_a_fleet_model_still_resolves_and_leaves_issuer_empty(client, run_worker, live):
    ids, job, _ = _classify_live(
        client,
        run_worker,
        live,
        {
            "instrument_model": "LSRFortessa",
            "instrument_confidence": 0.95,
            "report_type": "repair",
            "report_type_confidence": 0.92,
        },
    )
    result = job["classification"]
    assert result["maker_in_fleet"] is True and result["issuer"] is None
    assert result["resolved_template_id"] is not None
    report = client.get(f"/reports/{ids['report']['id']}").json()
    assert report["issuer"] is None and report["report_type_note"] is None
