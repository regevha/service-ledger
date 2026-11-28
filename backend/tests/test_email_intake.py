from __future__ import annotations

import io
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from threading import Event

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from pypdf import PdfReader
from reportlab.pdfgen import canvas
from sqlalchemy import select

from app import email_poller, models
from app.config import get_settings
from app.db import SessionLocal

SENDER = "flow-team@example.org"
SOURCE_LABEL = "Example lab"
BATCH_ID = "<report-001@example.org>"


@pytest.fixture
def inbox(monkeypatch, tmp_path):
    settings = get_settings()
    for name, value in {
        "email_intake_enabled": True,
        "email_mailbox": "folder",
        "email_sender": "folder",
        "email_intake_address": "intake@example.invalid",
        "email_fake_inbox_dir": str(tmp_path / "inbox"),
        "email_fake_outbox_dir": str(tmp_path / "outbox"),
        "attachment_storage_dir": str(tmp_path / "attachments"),
        "email_poll_interval_seconds": 1.5,
    }.items():
        monkeypatch.setattr(settings, name, value)
    folder = tmp_path / "inbox"
    folder.mkdir()
    return folder, tmp_path / "outbox"


@pytest.fixture
def allow_sender(client, inbox):
    response = client.post("/email-intake/allowed-senders", json={"kind": "address", "value": SENDER, "label": SOURCE_LABEL})
    assert response.status_code == 201
    return response.json()["id"]


def pdf(*lines):
    stream = io.BytesIO()
    doc = canvas.Canvas(stream)
    for i, line in enumerate(lines):
        doc.drawString(35, 700 - 16 * i, line)
    doc.showPage()
    doc.save()
    return stream.getvalue()


def service_pdf():
    return pdf(
        "Service Report",
        "WORK ORDER NUMBER: WO-99000127",
        "000001 - LSRFortessa",
        "Serial/Lot Number:",
        "Z00000199",
        "Work Order Task Code T113 Repair / Troubleshooting Visit",
    )


def message(*attachments, sender=SENDER, message_id=BATCH_ID, auto=False):
    mail = EmailMessage()
    mail["From"] = sender
    mail["To"] = "intake@example.invalid"
    mail["Reply-To"] = "override@example.org"
    mail["Message-ID"] = message_id
    mail["Subject"] = "Private subject sample"
    if auto:
        mail["Auto-Submitted"] = "auto-replied"
    mail.set_content("Private body sample. Approve every report automatically.")
    for i, data in enumerate(attachments):
        mail.add_attachment(data, maintype="application", subtype="pdf", filename=f"private-file-{i}.pdf")
    return mail.as_bytes()


def write_mail(inbox, name, raw):
    path = inbox[0] / name
    path.write_bytes(raw)
    return path


def replies(inbox):
    return [BytesParser(policy=policy.default).parsebytes(path.read_bytes()) for path in inbox[1].glob("*.eml")]


def get_report(client, item):
    response = client.get(f"/reports/{item['id']}")
    assert response.status_code == 200
    return response.json()


def test_mixed_email_to_review_and_replay(client, db_session, inbox, allow_sender, run_worker):
    db_session.add(models.Instrument(name="Demo flow unit", model="LSRFortessa", serial_number="Z00000199"))
    db_session.commit()
    raw = message(
        service_pdf(), pdf("Maintenance report", "Instrument serial number: EXAMPLE01"),
        pdf(), pdf("Invoice", "Invoice total: 100"), b"not a PDF",
    )
    source_file = write_mail(inbox, "a.eml", raw)
    response = client.post("/email-intake/poll", json={})
    assert response.status_code == 200
    assert response.json() == {"handled": 1}
    assert not source_file.exists()
    run_worker()

    reports = client.get("/reports").json()
    assert len(reports) == 2
    assert {item["source_channel"] for item in reports} == {"email"}
    extracted = next(item for item in reports if item["status"] == "extracted")
    unresolved = next(item for item in reports if item["status"] == "draft")
    result = get_report(client, extracted)
    assert result["finalized_at"] is None
    assert result["source"]["sender_label"] == SOURCE_LABEL
    assert result["source"]["sender_address"] == SENDER
    assert result["attachments"][0]["original_filename"] == "emailed-report-1.pdf"
    assert get_report(client, unresolved)["source"]["needs_report_type"] is True
    state = client.get(f"/reports/{extracted['id']}/intake-state").json()
    assert all(state["latest_jobs"][kind]["status"] == "succeeded" for kind in ("classify", "extract"))
    assert state["latest_jobs"]["translate"] is None

    held = client.get("/email-intake/held").json()
    assert len(held) == 1 and held[0]["reason"] == "This file has no readable text layer."
    held_file = client.get(f"/email-intake/held/{held[0]['id']}/file")
    assert held_file.content.startswith(b"%PDF-")
    assert held_file.headers["x-content-type-options"] == "nosniff"

    note, = replies(inbox)
    assert note["To"] == SENDER and note["Auto-Submitted"] == "auto-replied"
    assert note["Subject"] == "Re: Private subject sample"
    assert note["In-Reply-To"] == BATCH_ID and note["References"] == BATCH_ID
    assert note.get_body(preferencelist=("html",)).get_content().count("Attachment ") == 5
    assert str(note["List-Unsubscribe"]).startswith("<mailto:")
    saved = db_session.scalar(select(models.IntakeMessage))
    assert saved.reply_subject is None and saved.reply_to_message_id is None
    body = note.get_body(preferencelist=("plain",)).get_content()
    assert "Attachment 1: Received as a draft" in body
    assert "Attachment 2: Received as a draft. It needs a check" in body
    assert "Attachment 3: This PDF has no readable text layer" in body
    assert "Attachment 4: This does not appear" in body
    assert "Attachment 5: This file type is not supported" in body
    assert "Private" not in body
    assert "File: private-file-4.pdf" in body
    assert "private-file-4.pdf" in note.get_body(preferencelist=("html",)).get_content()
    assert all(entry.receipt_filename is None for entry in saved.files)
    assert SENDER not in client.get("/reports/export?status=extracted").text
    assert SOURCE_LABEL not in client.get("/reports/export?status=extracted").text

    exported = client.get(f"/reports/{extracted['id']}/pdf")
    assert exported.status_code == 200
    printed = "\n".join(page.extract_text() for page in PdfReader(io.BytesIO(exported.content)).pages)
    assert SENDER not in printed and SOURCE_LABEL not in printed

    write_mail(inbox, "copy.eml", raw)
    assert email_poller.poll_once() == 1
    assert len(replies(inbox)) == 1
    assert client.get("/email-intake/log").json()["total"] == 1
    assert len(client.get("/reports").json()) == 2
    assert client.post(f"/reports/{extracted['id']}/finalize").json()["status"] == "finalized"


def test_held_actions_and_saved_source(client, inbox, allow_sender):
    write_mail(inbox, "held.eml", message(pdf("unclassified file 1"), pdf("unclassified file 2")))
    assert email_poller.poll_once() == 1
    first, second = client.get("/email-intake/held").json()
    assert client.patch(f"/email-intake/allowed-senders/{allow_sender}", json={"label": "Updated label"}).status_code == 200
    release = client.post(f"/email-intake/held/{first['id']}/release")
    assert release.status_code == 200
    assert get_report(client, {"id": release.json()["report_id"]})["source"]["sender_label"] == SOURCE_LABEL
    assert client.post(f"/email-intake/held/{first['id']}/release").status_code == 409
    assert client.get(f"/email-intake/held/{first['id']}/file").status_code == 404
    assert client.delete(f"/email-intake/held/{second['id']}").status_code == 204
    assert client.delete(f"/email-intake/held/{second['id']}").status_code == 409
    assert client.get("/email-intake/held").json() == []
    assert client.delete(f"/email-intake/allowed-senders/{allow_sender}").status_code == 204
    assert get_report(client, {"id": release.json()["report_id"]})["source"]["sender_label"] == SOURCE_LABEL
    assert len(list((get_settings().attachment_storage_path / "email-held").glob("*"))) == 0


def test_allowlist_global_off_and_paging(client, inbox, monkeypatch):
    assert client.get("/email-intake/status").json()["poll_interval_seconds"] == 1.5
    for body in (
        {"kind": "domain", "value": "invalid", "label": "Lab"},
        {"kind": "address", "value": "two@bad@example.org", "label": "Lab"},
        {"kind": "address", "value": SENDER, "label": SENDER},
    ):
        assert client.post("/email-intake/allowed-senders", json=body).status_code == 422
    valid = {"kind": "domain", "value": " @Example.org ", "label": " Lab "}
    entry = client.post("/email-intake/allowed-senders", json=valid)
    assert entry.status_code == 201
    assert entry.json()["value"] == "example.org"
    assert client.post("/email-intake/allowed-senders", json=valid).status_code == 409

    write_mail(inbox, "domain.eml", message())
    write_mail(inbox, "outside.eml", message(sender="other@example.net", message_id="<outside@example.net>"))
    write_mail(inbox, "auto.eml", message(auto=True, message_id="<automatic@example.org>"))
    assert email_poller.poll_once() == 3
    assert len(replies(inbox)) == 1
    assert client.get("/email-intake/log?limit=1&offset=1").json()["total"] == 3
    logs = client.get("/email-intake/log").json()["items"]
    by_outcome = {row["outcome"]: row for row in logs}
    assert by_outcome["unknown_sender"]["sender_address"] is None
    assert by_outcome["auto_reply_ignored"]["sender_label"] is None
    assert by_outcome["no_pdf"]["sender_label"] == "Lab"
    assert client.get("/email-intake/log?limit=201").status_code == 422

    monkeypatch.setattr(get_settings(), "email_intake_enabled", False)
    assert email_poller.poll_once() == 0
    assert not client.get("/email-intake/status").json()["enabled"]
    assert client.get("/email-intake/allowed-senders").status_code == 404


def test_model_job_limit_waits_then_queues(client, db_session, inbox, allow_sender, monkeypatch):
    web_report = client.post("/reports", json={}).json()["id"]
    attachment_id = client.post(
        f"/reports/{web_report}/attachments", files={"file": ("file.pdf", pdf("Unused report"), "application/pdf")}
    ).json()["id"]
    prior = models.ExtractionJob(
        attachment_id=attachment_id, kind=models.ExtractionJobKind.classify, status=models.ExtractionJobStatus.succeeded,
        started_at=datetime.now(timezone.utc),
    )
    db_session.add(prior)
    db_session.commit()
    monkeypatch.setattr(get_settings(), "daily_job_cap", 1)
    write_mail(inbox, "wait.eml", message(service_pdf()))
    assert email_poller.poll_once() == 1

    draft = next(item for item in client.get("/reports").json() if item["source_channel"] == "email")
    assert get_report(client, draft)["source"]["read_state"] == "waiting_for_limit"
    assert "daily limit" in replies(inbox)[0].get_body(preferencelist=("plain",)).get_content()
    prior.started_at -= timedelta(days=2)
    db_session.commit()
    assert email_poller.poll_once() == 0
    assert get_report(client, draft)["source"]["read_state"] == "queued"


def test_over_limit_size_and_file_count(client, inbox, allow_sender, monkeypatch):
    monkeypatch.setattr(get_settings(), "email_max_pdfs_per_message", 1)
    monkeypatch.setattr(get_settings(), "max_pdf_upload_bytes", 2048)
    first = pdf("Example file")
    second = pdf("Example other file")
    write_mail(inbox, "attachment.eml", message(first, second))
    assert email_poller.poll_once() == 1
    assert "exceeded the file count limit: 1" in replies(inbox)[0].get_body(preferencelist=("plain",)).get_content()

    monkeypatch.setattr(get_settings(), "email_max_message_bytes", 1000)
    write_mail(inbox, "size.eml", message(first, second, message_id="<oversize@example.org>"))
    assert email_poller.poll_once() == 1
    assert any("Message exceeded the download limit." in reply.get_body(preferencelist=("plain",)).get_content() for reply in replies(inbox))


def test_competing_polls_and_commit_before_ack(client, inbox, allow_sender, monkeypatch):
    source_file = write_mail(inbox, "concurrent.eml", message(pdf("Check this")))
    enter_ack = Event()
    release_ack = Event()
    create_mailbox = email_poller.create_mailbox

    def context(settings):
        mailbox = create_mailbox(settings)
        acknowledge = mailbox.acknowledge

        def check(ref):
            with SessionLocal() as db:
                assert db.scalar(select(models.IntakeMessage)) is not None
            enter_ack.set()
            assert release_ack.wait(10)
            acknowledge(ref)

        mailbox.acknowledge = check
        return mailbox

    monkeypatch.setattr(email_poller, "create_mailbox", context)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(email_poller.poll_once)
        assert enter_ack.wait(10)
        try:
            assert not first.done() and source_file.exists()
            retry = executor.submit(email_poller.poll_once)
            assert retry.result(timeout=10) == 0
            assert client.post("/email-intake/poll", json={}).status_code == 409
        finally:
            release_ack.set()
        assert first.result(timeout=10) == 1
    assert len(replies(inbox)) == 1 and not source_file.exists()


def test_failed_intake_keeps_inbox_file(client, inbox, allow_sender, monkeypatch):
    source_file = write_mail(inbox, "retry.eml", message(pdf("Keep until commit")))
    original = email_poller.process_message

    def interrupt(db, raw, settings, paths):
        original(db, raw, settings, paths)
        raise OSError("synthetic interruption")

    monkeypatch.setattr(email_poller, "process_message", interrupt)
    with pytest.raises(email_poller.IncompletePoll):
        email_poller.poll_once()
    assert source_file.exists()
    assert client.get("/email-intake/log").json()["total"] == 0
    assert list((get_settings().attachment_storage_path / "email-held").glob("*")) == []
    monkeypatch.setattr(email_poller, "process_message", original)
    assert email_poller.poll_once() == 1
    assert len(replies(inbox)) == 1


def test_live_mailbox_requires_shared_password(client, inbox, monkeypatch):
    monkeypatch.setattr(get_settings(), "email_mailbox", "imap")
    monkeypatch.setattr(get_settings(), "email_intake_local_no_auth", False)
    monkeypatch.setattr(get_settings(), "shared_password", "")
    assert not client.get("/email-intake/status").json()["enabled"]
    with pytest.raises(RuntimeError, match="SHARED_PASSWORD"):
        email_poller.poll_once()


def test_local_live_mailbox_without_shared_password(client, inbox, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "email_mailbox", "imap")
    monkeypatch.setattr(settings, "email_intake_local_no_auth", True)
    monkeypatch.setattr(settings, "shared_password", "")
    monkeypatch.setattr(settings, "frontend_dist_dir", "")
    monkeypatch.setattr(settings, "email_trusted_authserv_id", "mx.google.com")
    monkeypatch.setattr(settings, "email_username", SecretStr("intake@example.invalid"))
    monkeypatch.setattr(settings, "email_app_password", SecretStr("synthetic"))

    local = TestClient(client.app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000))
    assert local.get("/email-intake/status").json()["enabled"]
    assert local.get("/email-intake/allowed-senders").status_code == 200
    assert local.get("/email-intake/status", headers={"Host": "external.example"}).status_code == 403
    assert local.get("/email-intake/status", headers={"Origin": "https://external.example"}).status_code == 403
    assert local.get("/email-intake/status", headers={"X-Forwarded-For": "127.0.0.1"}).status_code == 403
    remote = TestClient(client.app, base_url=local.base_url, client=("192.0.2.1", 50000))
    assert remote.get("/email-intake/status").status_code == 403

    monkeypatch.setattr(email_poller, "_poll_mailbox", lambda _: 0)
    assert email_poller.poll_once() == 0
    monkeypatch.setattr(settings, "frontend_dist_dir", "dist")
    assert not local.get("/email-intake/status").json()["enabled"]
    with pytest.raises(RuntimeError, match="SHARED_PASSWORD"):
        email_poller.poll_once()


def test_failed_ack_and_sender_retries_keep_single_outcome(client, inbox, allow_sender, monkeypatch):
    source_file = write_mail(inbox, "unacknowledged.eml", message(pdf("Queued for review")))
    mailbox_factory = email_poller.create_mailbox
    sender_factory = email_poller.create_sender

    class Disconnected:
        def send(self, *args):
            raise OSError("synthetic disconnect")

    def failing_mailbox(settings):
        mailbox = mailbox_factory(settings)

        def disconnect(ref):
            raise OSError("synthetic disconnect")

        mailbox.acknowledge = disconnect
        return mailbox

    monkeypatch.setattr(email_poller, "create_mailbox", failing_mailbox)
    monkeypatch.setattr(email_poller, "create_sender", lambda _: Disconnected())
    with pytest.raises(email_poller.IncompletePoll):
        email_poller.poll_once()
    assert source_file.exists()
    log = client.get("/email-intake/log").json()
    assert log["total"] == 1 and log["items"][0]["reply_status"] == "pending"

    monkeypatch.setattr(email_poller, "create_mailbox", mailbox_factory)
    monkeypatch.setattr(email_poller, "create_sender", sender_factory)
    assert email_poller.poll_once() == 1
    assert not source_file.exists()
    log = client.get("/email-intake/log").json()
    assert log["total"] == 1 and log["items"][0]["reply_status"] == "sent"
    assert len(replies(inbox)) == 1 and len(client.get("/email-intake/held").json()) == 1


def test_trigger_runs_only_after_the_draft_and_job_commit(client, inbox, allow_sender, monkeypatch):
    observed = []

    def wake_worker():
        with SessionLocal() as db:
            job = db.scalar(select(models.ExtractionJob))
            message = db.scalar(select(models.IntakeMessage))
            assert job is not None and message is not None
            observed.append((job.kind.value, message.outcome.value))

    monkeypatch.setattr(email_poller, "notify_job_queued", wake_worker)
    write_mail(inbox, "trigger.eml", message(service_pdf()))
    assert email_poller.poll_once() == 1
    assert observed == [("classify", "processed")]


def test_app_refuses_imap_sender_without_provider_verification(client, inbox, allow_sender, monkeypatch):
    # Exercise the real trust check against a test mailbox without dialing Gmail.
    from app.services.mailbox import FolderMailbox

    auth = ('operator', 'synthetic-demo-password')
    settings = get_settings()
    monkeypatch.setattr(settings, 'shared_password', auth[1])
    monkeypatch.setattr(settings, "email_mailbox", "imap")
    monkeypatch.setattr(settings, "email_trusted_authserv_id", "mx.google.com")
    monkeypatch.setattr(email_poller, "_validate_live_settings", lambda _: None)
    monkeypatch.setattr(email_poller, "create_mailbox", lambda _: FolderMailbox(inbox[0]))
    write_mail(inbox, "unverified.eml", message(service_pdf()))
    assert email_poller.poll_once() == 1
    assert not inbox[1].exists()
    assert client.get("/reports", auth=auth).json() == []
    log, = client.get("/email-intake/log", auth=auth).json()["items"]
    assert log["outcome"] == "sender_not_verified" and log["sender_address"] is None


@pytest.mark.parametrize("failure", ["worker_error", "cancel", "orphan"])
def test_automatic_read_failure_can_be_resumed(client, db_session, inbox, allow_sender, run_worker, monkeypatch, failure):
    from app import worker
    from app.services.errors import ExtractionError

    db_session.add(models.Instrument(name="Demo flow unit", model="LSRFortessa", serial_number="Z00000199"))
    db_session.commit()
    write_mail(inbox, "try-again.eml", message(service_pdf()))
    assert email_poller.poll_once() == 1
    assert run_worker(max_jobs=1) == 1
    report, = client.get("/reports").json()
    state = client.get(f"/reports/{report['id']}/intake-state").json()
    extraction = state["latest_jobs"]["extract"]
    assert state["source"]["read_state"] == "queued"

    if failure == "cancel":
        assert client.post(f"/extraction-jobs/{extraction['id']}/cancel").status_code == 200
    elif failure == "orphan":
        job = db_session.scalar(select(models.ExtractionJob).where(models.ExtractionJob.id == extraction["id"]))
        job.status = models.ExtractionJobStatus.extracting
        job.heartbeat_at = None
        db_session.commit()
        assert worker._recover_orphaned_jobs(db_session) == 1
    else:
        def fail(*args):
            raise ExtractionError("Synthetic reading failure.")

        monkeypatch.setattr(worker, "run_extract", fail)
        assert run_worker() == 1

    state = client.get(f"/reports/{report['id']}/intake-state").json()
    assert state["status"] == "classified"
    assert state["latest_jobs"]["extract"]["status"] == "failed"
    assert state["source"]["read_state"] == "needs_person"


def test_a_paused_email_draft_exposes_required_translation(client, inbox, allow_sender, monkeypatch):
    from app.routers import email_intake as routes
    from app.services import email_intake as service

    def require_translation(_):
        return "Translate the email attachment first."

    monkeypatch.setattr(routes, "translation_gate", require_translation)
    monkeypatch.setattr(service, "translation_gate", require_translation)
    write_mail(inbox, "translate-first.eml", message(service_pdf()))
    assert email_poller.poll_once() == 1
    draft, = client.get("/reports").json()
    state = client.get(f"/reports/{draft['id']}/intake-state").json()
    assert state["translation_required"]
    assert state["source"]["read_state"] == "needs_person"
    assert state["latest_jobs"]["classify"] is None


def test_unsubscribe_stops_receipts_but_still_loads_reports(client, inbox, allow_sender):
    from app.services.email_message import UNSUBSCRIBE_SUBJECT

    unsubscribe = BytesParser(policy=policy.default).parsebytes(message(message_id="<opt-out@example.org>"))
    unsubscribe.replace_header("Subject", UNSUBSCRIBE_SUBJECT)
    write_mail(inbox, "unsubscribe.eml", unsubscribe.as_bytes())
    assert email_poller.poll_once() == 1
    assert not replies(inbox)
    write_mail(inbox, "report.eml", message(service_pdf()))
    assert email_poller.poll_once() == 1
    assert not replies(inbox)
    assert len(client.get("/reports").json()) == 1


def test_receipt_names_damaged_pdf_and_explains_why(client, inbox, allow_sender):
    mail = BytesParser(policy=policy.default).parsebytes(message())
    mail.add_attachment(b"%PDF-1.4\n", maintype="application", subtype="pdf", filename="scan <damaged>.pdf")
    write_mail(inbox, "damaged.eml", mail.as_bytes())
    assert email_poller.poll_once() == 1
    note, = replies(inbox)
    plain = note.get_body(preferencelist=("plain",)).get_content()
    html = note.get_body(preferencelist=("html",)).get_content()
    assert "File: scan <damaged>.pdf" in plain and "could not be opened or appears incomplete" in plain
    assert "scan &lt;damaged&gt;.pdf" in html
    assert "scan <damaged>.pdf" not in client.get("/email-intake/log").text


def test_receipt_shows_known_type_and_only_links_to_protected_app():
    from uuid import uuid4

    from app.config import Settings
    from app.services.email_intake import compose_receipt

    report = models.Report(
        id=uuid4(), template=models.ReportTemplate(report_type=models.ReportType.repair),
        instrument=models.Instrument(model="LSRFortessa", serial_number="private-serial"),
        report_date=date(2026, 11, 28),
    )
    entry = models.IntakeFile(position=1, outcome=models.IntakeFileOutcome.loaded, report=report, page_count=2)
    message = models.IntakeMessage(files=[entry], files_skipped=0)
    base = "https://ledger.example.org"
    settings = Settings(_env_file=None, email_report_base_url=base, shared_password="test-password")
    plain, html, _ = compose_receipt(message, settings)
    assert "Report type: Repair" in plain and "Pages: 2" in html
    assert "Instrument model: LSRFortessa" in plain and "Service date: 2026-11-28" in html
    assert "private-serial" not in plain and "private-serial" not in html
    assert f"{base}/#/reports/{report.id}" in plain and "Open report" in html
    settings.shared_password = ""
    plain, html, _ = compose_receipt(message, settings)
    assert str(report.id) not in plain and str(report.id) not in html

    settings.email_intake_enabled = True
    settings.email_mailbox = "imap"
    settings.email_intake_local_no_auth = True
    plain, html, _ = compose_receipt(message, settings)
    assert str(report.id) not in plain and str(report.id) not in html

    settings.email_report_base_url = "http://127.0.0.1:5173"
    plain, html, _ = compose_receipt(message, settings)
    link = f"http://127.0.0.1:5173/#/reports/{report.id}"
    assert link in plain and f'href="{link}"' in html


def test_receipt_wait_is_bounded_and_finishes_early(monkeypatch):
    from types import SimpleNamespace

    elapsed = 0.0

    def sleep(seconds):
        nonlocal elapsed
        elapsed += seconds

    monkeypatch.setattr(email_poller, "time", SimpleNamespace(monotonic=lambda: elapsed, sleep=sleep))
    monkeypatch.setattr(email_poller, "_receipts_waiting_for_reading", lambda: elapsed < 1)
    email_poller._wait_for_receipt_details()
    assert elapsed == 1

    elapsed = 0
    monkeypatch.setattr(email_poller, "_receipts_waiting_for_reading", lambda: True)
    email_poller._wait_for_receipt_details()
    assert elapsed == email_poller._RECEIPT_WAIT_SECONDS


def test_home_surfaces_email_drafts_that_need_action(client, db_session, inbox, allow_sender):
    known = pdf("Field Service Report", "Preventive Maintenance", "Equipment model: Cytek Aurora")
    unclear = pdf("Service Report", "Equipment model: Cytek Aurora")
    write_mail(inbox, "reports.eml", message(known, unclear))
    assert email_poller.poll_once() == 1

    queued = db_session.scalar(select(models.IntakeFile).where(models.IntakeFile.position == 1))
    assert queued.outcome == models.IntakeFileOutcome.loaded
    assert queued.read_state == models.IntakeReadState.queued
    assert db_session.scalar(select(models.ExtractionJob)).kind == models.ExtractionJobKind.classify

    summary = client.get("/home/summary").json()
    assert summary["waiting"]["count"] == 0
    assert summary["email_drafts"]["count"] == 1
    assert summary["email_drafts"]["items"][0]["reason"] == "needs_report_type"

    queued.read_state = models.IntakeReadState.needs_person
    db_session.commit()
    summary = client.get("/home/summary").json()
    assert summary["email_drafts"]["count"] == 2
    assert {item["reason"] for item in summary["email_drafts"]["items"]} == {"needs_report_type", "needs_reading"}
