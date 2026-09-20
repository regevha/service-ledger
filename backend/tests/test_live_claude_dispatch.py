"""End-to-end coverage for the `settings.use_live_claude` dispatch branch in
`classify()`/`extract()` (app/services/classification.py, .../extraction.py).

test_live_claude_parsing.py already exercises every parsing/error-handling
edge case *inside* `_live_classify`/`_live_extract` directly, and
test_document_first_flow.py already exercises `classify()`/`extract()`'s full
public contract (auto-resolve, manual-confirm fallback, finalize) end to end
— but always in stub mode (conftest.py forces `USE_LIVE_CLAUDE=false` for the
whole suite). Neither ever calls the public `classify()`/`extract()` entry
points with `settings.use_live_claude=True`, so the one-line
`if settings.use_live_claude: return _live_...(...)` branch each file's
coverage report flags as missed has never actually run under any test.

This file closes that gap by driving the real submit -> worker -> poll flow
(the same shape test_document_first_flow.py uses) with the flag flipped on
and only the Anthropic client itself mocked — so `classify()`/`extract()`
have to choose the live path on their own for this test to pass, rather than
the test calling `_live_classify`/`_live_extract` directly and assuming the
dispatch above them is correct.
"""
from __future__ import annotations

from types import SimpleNamespace

from app.services import classification, extraction


class _FakeMessages:
    def __init__(self, response):
        self._response = response
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._response


class _FakeClient:
    def __init__(self, response):
        self.messages = _FakeMessages(response)


def _tool_use_response(input_dict: dict):
    return SimpleNamespace(content=[SimpleNamespace(type="tool_use", input=input_dict)])


def test_use_live_claude_true_routes_classify_and_extract_through_the_live_path(client, run_worker, monkeypatch):
    # classification.settings and extraction.settings are the same cached
    # Settings instance (get_settings() is @lru_cache'd) — one assignment
    # flips the flag both classify() and extract() branch on.
    monkeypatch.setattr(classification.settings, "use_live_claude", True)

    fake_classify_client = _FakeClient(
        _tool_use_response(
            {
                "instrument_model": "LSRFortessa",
                "instrument_confidence": 0.95,
                "report_type": "repair",
                "report_type_confidence": 0.92,
            }
        )
    )
    monkeypatch.setattr(classification, "_get_client", lambda: fake_classify_client)

    report = client.post("/reports", json={"technician_name": "Live Dispatch Test"}).json()
    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("live_repair_scan.pdf", b"%PDF-1.4 fake live scan", "application/pdf")},
    )
    assert upload.status_code == 201
    attachment = upload.json()

    submitted = client.post(f"/attachments/{attachment['id']}/classify")
    assert submitted.status_code == 202
    run_worker()

    # If classify() had silently taken the stub path instead of the live one,
    # this fake client would never have been called at all — this is the
    # load-bearing assertion that the live branch actually ran, not just that
    # it produced a plausible-looking result.
    assert len(fake_classify_client.messages.calls) == 1
    assert fake_classify_client.messages.calls[0]["model"] == "claude-sonnet-5"

    job = client.get(f"/extraction-jobs/{submitted.json()['id']}").json()
    assert job["status"] == "succeeded"
    classification_result = job["classification"]
    assert classification_result["instrument"]["value"] == "LSRFortessa"
    assert classification_result["instrument"]["confidence"] == 0.95
    assert classification_result["report_type"]["value"] == "repair"
    assert classification_result["resolved_template_id"] is not None  # both confidences cleared the threshold

    refreshed = client.get(f"/reports/{report['id']}").json()
    assert refreshed["status"] == "classified"
    template_id = refreshed["template_id"]

    all_templates = client.get("/report-templates").json()
    fields = next(t for t in all_templates if t["id"] == template_id)["field_schema"]["fields"]
    field_names = {f["name"] for f in fields}
    # Confirms this resolved to the shared repair template, so the extract
    # mock below can be built against its real, exact field schema.
    assert field_names == {
        "fault_description",
        "root_cause",
        "work_performed",
        "components_replaced",
        "labor_hours",
        "fault_category",
        "retest_result",
    }

    fake_extract_client = _FakeClient(
        _tool_use_response(
            {
                "fault_description": "Live-path fault description",
                "fault_description__confidence": 0.9,
                "root_cause": "Live-path root cause",
                "root_cause__confidence": 0.8,
                "work_performed": "Live-path work performed narrative",
                "work_performed__confidence": 0.93,
                "components_replaced": [{"part_name": "O-ring", "part_number": "OR-100", "qty": 1}],
                "components_replaced__confidence": 0.85,
                "labor_hours": 3.5,
                "labor_hours__confidence": 0.88,
                "fault_category": "fluidics",
                "fault_category__confidence": 0.91,
                "retest_result": "pass",
                "retest_result__confidence": 0.97,
            }
        )
    )
    monkeypatch.setattr(extraction, "_get_client", lambda: fake_extract_client)

    extract_submitted = client.post(f"/attachments/{attachment['id']}/extract")
    assert extract_submitted.status_code == 202
    run_worker()

    assert len(fake_extract_client.messages.calls) == 1
    assert fake_extract_client.messages.calls[0]["model"] == "claude-sonnet-5"

    extract_job = client.get(f"/extraction-jobs/{extract_submitted.json()['id']}").json()
    assert extract_job["status"] == "succeeded"
    assert extract_job["field_confidences"]["fault_description"] == 0.9
    assert extract_job["field_confidences"]["components_replaced"] == 0.85

    extracted_report = client.get(f"/reports/{report['id']}").json()
    assert extracted_report["status"] == "extracted"
    assert extracted_report["extracted_fields"]["fault_description"] == "Live-path fault description"
    assert extracted_report["extracted_fields"]["labor_hours"] == 3.5
    assert extracted_report["extracted_fields"]["components_replaced"] == [
        {"part_name": "O-ring", "part_number": "OR-100", "qty": 1}
    ]
