"""GET /report-templates/usage: how many reports use each template."""
from __future__ import annotations

from app import models
from tests.conftest import TestSessionLocal


def _template_id(client, model="LSRFortessa", report_type="repair"):
    return client.get("/report-templates", params={"report_type": report_type, "model": model}).json()[0]["id"]


def _report_on(client, template_id, finalize=False):
    report = client.post("/reports", json={}).json()
    instrument = client.get("/instruments").json()[0]
    response = client.patch(
        f"/reports/{report['id']}/template", json={"instrument_id": instrument["id"], "template_id": template_id}
    )
    assert response.status_code == 200, response.text
    if finalize:
        with TestSessionLocal() as db:
            row = db.get(models.Report, __import__("uuid").UUID(report["id"]))
            row.status = models.ReportStatus.finalized
            db.commit()
    return report["id"]


def test_usage_is_empty_when_no_report_uses_a_template(client):
    assert client.get("/report-templates/usage").json() == []


def test_usage_counts_reports_and_finalized_reports_per_template(client):
    fortessa = _template_id(client)
    other = _template_id(client, model="FACSAria III", report_type="preventive_maintenance")
    _report_on(client, fortessa)
    _report_on(client, fortessa, finalize=True)
    _report_on(client, fortessa, finalize=True)
    _report_on(client, other)

    usage = {u["template_id"]: u for u in client.get("/report-templates/usage").json()}

    assert usage[fortessa]["report_count"] == 3 and usage[fortessa]["finalized_count"] == 2
    assert usage[other]["report_count"] == 1 and usage[other]["finalized_count"] == 0
    assert len(usage) == 2


def test_reports_without_a_template_are_not_counted(client):
    client.post("/reports", json={})
    assert client.get("/report-templates/usage").json() == []


def test_usage_follows_report_deletion(client):
    template = _template_id(client)
    report = _report_on(client, template)
    assert client.get("/report-templates/usage").json()[0]["report_count"] == 1

    client.delete(f"/reports/{report}")

    assert client.get("/report-templates/usage").json() == []


def test_usage_is_not_mistaken_for_a_template_id(client):
    assert client.get("/report-templates/usage").status_code == 200
