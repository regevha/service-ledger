"""GET /reports/{id}/duplicates: the indicator for an already-saved report.
Flags another report holding the same scan (identical bytes), or the same
normalized work-order number on the same instrument. The same work order on a
different instrument is deliberately not flagged here.
"""
from __future__ import annotations

import hashlib
import uuid

from app.models import Attachment, Instrument, Report, ReportStatus
from tests.conftest import TestSessionLocal
from tests.test_text_reader import make_pdf, service_report


def _instrument(db, serial: str, model: str = "LSRFortessa") -> Instrument:
    row = Instrument(name=serial, model=model, serial_number=serial)
    db.add(row)
    db.commit()
    return row


def _report(db, *, instrument=None, work_order: str | None = None, sha: str | None = None,
            status=ReportStatus.finalized, technician="T. Tech") -> Report:
    report = Report(instrument_id=instrument.id if instrument else None, status=status, technician_name=technician)
    db.add(report)
    db.commit()
    if work_order is not None or sha is not None:
        db.add(Attachment(report_id=report.id, file_path=f"/nonexistent/{uuid.uuid4()}.pdf", file_type="application/pdf",
                          work_order_number=work_order, content_sha256=sha))
        db.commit()
    return report


def _duplicates(client, report) -> list[dict]:
    resp = client.get(f"/reports/{report.id}/duplicates")
    assert resp.status_code == 200
    return resp.json()


def test_unknown_report_is_404(client):
    assert client.get(f"/reports/{uuid.uuid4()}/duplicates").status_code == 404


def test_a_report_with_no_scan_has_no_duplicates(client, db_session):
    assert _duplicates(client, _report(db_session)) == []


def test_the_same_work_order_on_the_same_instrument_is_flagged_from_both_sides(client, db_session):
    inst = _instrument(db_session, "DUP-1")
    first = _report(db_session, instrument=inst, work_order="04587090", technician="First")
    second = _report(db_session, instrument=inst, work_order="04587090", technician="Second")

    from_second = _duplicates(client, second)
    assert [d["id"] for d in from_second] == [str(first.id)]
    assert from_second[0]["reason"] == "same_work_order"
    assert from_second[0]["work_order_number"] == "04587090"
    assert from_second[0]["status"] == "finalized" and from_second[0]["technician_name"] == "First"
    assert from_second[0]["instrument_serial_number"] == "DUP-1"  # list-item shape, ready to open

    assert [d["id"] for d in _duplicates(client, first)] == [str(second.id)]  # symmetric


def test_the_same_work_order_on_a_different_instrument_is_not_flagged(client, db_session):
    a, b = _instrument(db_session, "DUP-A"), _instrument(db_session, "DUP-B")  # same model, other serial
    one = _report(db_session, instrument=a, work_order="04587090")
    _report(db_session, instrument=b, work_order="04587090")

    assert _duplicates(client, one) == []


def test_a_report_with_no_instrument_yet_is_not_matched_on_work_order(client, db_session):
    inst = _instrument(db_session, "DUP-2")
    _report(db_session, instrument=inst, work_order="04587090")
    draft = _report(db_session, instrument=None, work_order="04587090", status=ReportStatus.draft)

    assert _duplicates(client, draft) == []


def test_different_work_orders_on_the_same_instrument_are_fine(client, db_session):
    inst = _instrument(db_session, "DUP-3")
    one = _report(db_session, instrument=inst, work_order="04587090")
    _report(db_session, instrument=inst, work_order="04587091")

    assert _duplicates(client, one) == []


def test_identical_file_is_flagged_even_on_another_instrument_and_wins_over_work_order(client, db_session):
    a, b = _instrument(db_session, "DUP-4"), _instrument(db_session, "DUP-5")
    sha = hashlib.sha256(b"same bytes").hexdigest()
    one = _report(db_session, instrument=a, work_order="04587090", sha=sha)
    other = _report(db_session, instrument=b, work_order="04587090", sha=sha)
    inst_a = _report(db_session, instrument=a, work_order="04587090")  # same instrument + work order, different file

    found = {d["id"]: d["reason"] for d in _duplicates(client, one)}

    assert found == {str(other.id): "same_file", str(inst_a.id): "same_work_order"}


def test_a_report_with_several_matching_scans_is_listed_once(client, db_session):
    inst = _instrument(db_session, "DUP-6")
    one = _report(db_session, instrument=inst, work_order="04587090")
    other = _report(db_session, instrument=inst, work_order="04587090")
    db_session.add(Attachment(report_id=other.id, file_path="/nonexistent/extra.pdf", file_type="application/pdf",
                              work_order_number="04587090"))
    db_session.commit()

    assert [d["id"] for d in _duplicates(client, one)] == [str(other.id)]


def test_the_indicator_follows_deletion(client, db_session):
    inst = _instrument(db_session, "DUP-7")
    one = _report(db_session, instrument=inst, work_order="04587090")
    two = _report(db_session, instrument=inst, work_order="04587090")
    assert len(_duplicates(client, one)) == 1

    assert client.delete(f"/reports/{two.id}", params={"force": "true"}).status_code == 204

    assert _duplicates(client, one) == []


def test_end_to_end_two_scans_of_one_visit_on_one_instrument(client, run_worker):
    """Real upload path: the work order is read from each PDF's own text, the
    reports are confirmed onto the same instrument, and the second one's screen
    flags the first. Different bytes (a rescan), so only the work order matches."""
    instrument = client.get("/instruments").json()
    fortessa = next(i for i in instrument if i["model"] == "LSRFortessa")
    template = client.get("/report-templates", params={"report_type": "repair", "model": "LSRFortessa"}).json()[0]
    reports = []
    for extra in ([], ["scanned twice"]):
        report = client.post("/reports", json={}).json()
        pdf = make_pdf(service_report(work_order="WO-77123456") + extra)
        assert client.post(f"/reports/{report['id']}/attachments",
                           files={"file": ("scan.pdf", pdf, "application/pdf")}).status_code == 201
        assert client.patch(f"/reports/{report['id']}/template",
                            json={"instrument_id": fortessa["id"], "template_id": template["id"]}).status_code == 200
        reports.append(report)

    found = client.get(f"/reports/{reports[1]['id']}/duplicates").json()

    assert [d["id"] for d in found] == [reports[0]["id"]]
    assert found[0]["reason"] == "same_work_order" and found[0]["work_order_number"] == "77123456"
