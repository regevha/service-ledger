"""The installation_upgrade report type (BD task code T107, "Install:
Options, Upgrades, S/W").

Added after a real FACSDiscover S8 software-upgrade report fit none of
repair / preventive_maintenance / calibration: its task code is T107, so the
type used to come from the model alone, with low confidence, and every such
report fell to the manual pick. It now has a type, a shared template and a
task-code mapping like the others.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.models import ReportType
from app.schemas import ClassificationGuess
from app.services import classification
from app.services.classification import DocumentRead, report_type_from_task_code
from app.services.templates import resolve_template

PDF = ("scan.pdf", b"%PDF-1.4 install scan", "application/pdf")
MODELS = ("LSRFortessa", "FACSAria III", "FACSDiscover S8")


# ---------- task code ----------


@pytest.mark.parametrize("printed", ["T107", "t107", " T107 Install: Options, Upgrades, S/W"])
def test_t107_means_installation_upgrade(printed):
    assert report_type_from_task_code(printed) == ReportType.installation_upgrade


def test_the_other_task_codes_are_unchanged():
    assert report_type_from_task_code("T113") == ReportType.repair
    assert report_type_from_task_code("T111") == ReportType.preventive_maintenance
    assert report_type_from_task_code("T108") is None


def test_the_live_call_types_a_t107_report_from_its_task_code(tmp_path, monkeypatch):
    scan = tmp_path / "scan.pdf"
    scan.write_bytes(b"%PDF-1.4 upgrade")
    answer = {
        "instrument_model": "FACSDiscover S8",
        "instrument_confidence": 0.97,
        # What the model alone made of an upgrade report: not confident.
        "report_type": "repair",
        "report_type_confidence": 0.4,
        "task_code": "T107",
        "task_code_confidence": 0.96,
        "work_order_number": "WO-04482628",
    }

    class _Messages:
        calls: list = []

        def create(self, **kwargs):
            self.calls.append(kwargs)
            return SimpleNamespace(content=[SimpleNamespace(type="tool_use", input=answer)])

    client = SimpleNamespace(messages=_Messages())
    monkeypatch.setattr(classification, "_get_client", lambda: client)

    read = classification._live_classify(None, SimpleNamespace(file_path=str(scan)), [SimpleNamespace(model="FACSDiscover S8")])

    assert (read.report_type.value, read.report_type.confidence) == ("installation_upgrade", 0.96)
    assert read.report_type_source == "task_code"
    sent = client.messages.calls[0]
    # The model is offered the new type, and told what T107 means.
    assert "installation_upgrade" in sent["tools"][0]["input_schema"]["properties"]["report_type"]["enum"]
    assert "T107" in sent["messages"][0]["content"][-1]["text"]


# ---------- template ----------


@pytest.mark.parametrize("model", MODELS)
def test_every_model_resolves_the_shared_installation_template(seeded, model):
    template = resolve_template(seeded, instrument_type="facs", report_type="installation_upgrade", model=model)
    assert template is not None and template.model is None
    names = [f["name"] for f in template.field_schema["fields"]]
    assert names == ["service_description", "work_performed", "parts_used", "labor_hours", "verification_result"]


def test_the_template_api_lists_the_new_type(client):
    resp = client.get("/report-templates", params={"report_type": "installation_upgrade", "model": "FACSDiscover S8"})
    assert resp.status_code == 200
    assert [t["report_type"] for t in resp.json()] == ["installation_upgrade"]


# ---------- the whole pipeline ----------


def test_a_confident_t107_report_resolves_extracts_and_finalizes(client, run_worker, monkeypatch):
    monkeypatch.setattr(
        "app.services.classification._stub_classify",
        lambda attachment, instruments: DocumentRead(
            ClassificationGuess(value="FACSDiscover S8", confidence=0.97),
            ClassificationGuess(value="installation_upgrade", confidence=0.96),
            None,
            "WO-04482628",
            "task_code",
        ),
    )
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()

    job = client.post(f"/attachments/{attachment['id']}/classify").json()
    run_worker()
    result = client.get(f"/extraction-jobs/{job['id']}").json()["classification"]
    # Confident on both guesses, so straight through with no manual pick.
    assert result["report_type"]["value"] == "installation_upgrade"
    assert result["report_type_source"] == "task_code"
    assert result["resolved_template_id"] is not None and result["resolved_instrument_id"] is not None

    resolved = client.get(f"/reports/{report['id']}").json()
    assert resolved["status"] == "classified"
    template = client.get(f"/report-templates/{resolved['template_id']}").json()
    assert template["report_type"] == "installation_upgrade"

    client.post(f"/attachments/{attachment['id']}/extract")
    run_worker()
    extracted = client.get(f"/reports/{report['id']}").json()
    assert extracted["status"] == "extracted"
    assert set(extracted["extracted_fields"]) == {
        "service_description", "work_performed", "parts_used", "labor_hours", "verification_result",
    }

    assert client.post(f"/reports/{report['id']}/finalize").json()["status"] == "finalized"

    # Filterable, exportable and printable like every other type.
    listed = client.get("/reports", params={"report_type": "installation_upgrade"}).json()
    assert [r["id"] for r in listed] == [report["id"]]
    assert client.get("/reports", params={"report_type": "repair"}).json() == []
    csv = client.get("/reports/export", params={"report_type": "installation_upgrade"})
    assert csv.status_code == 200 and "installation_upgrade" in csv.text
    pdf = client.get(f"/reports/{report['id']}/pdf")
    assert pdf.status_code == 200 and pdf.headers["content-type"] == "application/pdf"


def test_an_installation_report_is_left_out_of_the_fleet_analytics_figures(client, run_worker, monkeypatch):
    """Labor and pass/fail analytics cover repair and PM only (calibration is
    likewise left out); a new type must not appear as a row or break the endpoint."""
    monkeypatch.setattr(
        "app.services.classification._stub_classify",
        lambda attachment, instruments: DocumentRead(
            ClassificationGuess(value="LSRFortessa", confidence=0.97),
            ClassificationGuess(value="installation_upgrade", confidence=0.96),
            None,
        ),
    )
    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()
    client.post(f"/attachments/{attachment['id']}/classify")
    run_worker()
    client.post(f"/attachments/{attachment['id']}/extract")
    run_worker()
    client.post(f"/reports/{report['id']}/finalize")

    resp = client.get("/analytics/fleet")
    assert resp.status_code == 200
    assert set(resp.json()["pass_fail_by_report_type"]) == {"repair", "preventive_maintenance"}
