"""Synthetic email boundary and recovery contracts; never connect to a mail server."""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timedelta, timezone
from email import policy
from email.parser import BytesParser
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from pydantic import SecretStr
from sqlalchemy import select

from app import email_poller, models
from app.config import get_settings
from app.services import email_intake as intake
from app.tools import email_demo_send
from tests import test_email_intake as email_helpers
from tests.test_email_intake import message, pdf, replies, write_mail

inbox = email_helpers.inbox


@pytest.mark.parametrize("explicit_id", [None, "<synthetic@example.invalid>"])
def test_demo_places_parseable_message_atomically(inbox, tmp_path, monkeypatch, capsys, explicit_id):
    first = tmp_path / "one.pdf"
    second = tmp_path / "two.pdf"
    first.write_bytes(pdf("First report"))
    second.write_bytes(pdf("Second report"))
    args = ["email-demo", "--from", "team@example.org"]
    if explicit_id:
        args += ["--message-id", explicit_id]
    monkeypatch.setattr(sys, "argv", args + [str(first), str(second)])
    email_demo_send.main()
    output, = inbox[0].glob("*.eml")
    parsed = BytesParser(policy=policy.default).parsebytes(output.read_bytes())
    assert parsed["From"] == "team@example.org"
    assert parsed["To"] == get_settings().email_intake_address
    if explicit_id:
        assert parsed["Message-ID"] == explicit_id
    else:
        assert str(parsed["Message-ID"]).endswith("@example.invalid>")
    assert [part.get_payload(decode=True) for part in parsed.iter_attachments()] == [first.read_bytes(), second.read_bytes()]
    assert not list(inbox[0].glob("*.tmp"))
    assert "2 attachment(s)" in capsys.readouterr().out


@pytest.mark.parametrize("failure", ["disabled", "imap", "missing", "oversize", "encoded_size"])
def test_demo_refuses_invalid_inputs_without_writing(inbox, tmp_path, monkeypatch, capsys, failure):
    source = tmp_path / "sample.pdf"
    source.write_bytes(b"%PDF-synthetic")
    settings = get_settings()
    if failure == "disabled":
        monkeypatch.setattr(settings, "email_intake_enabled", False)
    elif failure == "imap":
        monkeypatch.setattr(settings, "email_mailbox", "imap")
    elif failure == "missing":
        source.unlink()
    elif failure == "oversize":
        monkeypatch.setattr(settings, "max_pdf_upload_bytes", 1)
    else:
        monkeypatch.setattr(settings, "email_max_message_bytes", 1)
    monkeypatch.setattr(sys, "argv", ["email-demo", "--from", "team@example.org", str(source)])
    with pytest.raises(SystemExit) as error:
        email_demo_send.main()
    assert error.value.code == 2
    assert "error:" in capsys.readouterr().err
    assert list(inbox[0].iterdir()) == []


def test_demo_cleans_temporary_file_when_publish_fails(inbox, tmp_path, monkeypatch):
    from pathlib import Path
    source = tmp_path / "report.pdf"
    source.write_bytes(pdf("Synthetic report"))
    monkeypatch.setattr(sys, "argv", ["email-demo", "--from", "team@example.org", str(source)])
    def fail_replace(self, target):
        raise OSError("synthetic publish failure")
    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(OSError, match="publish failure"):
        email_demo_send.main()
    assert list(inbox[0].iterdir()) == []


@pytest.mark.parametrize("mailbox,sender,password,authserv,username,app_password,expected", [
    ("imap", "folder", "", "", "", "", "SHARED_PASSWORD"),
    ("imap", "folder", "configured", "  ", "", "", "EMAIL_TRUSTED_AUTHSERV_ID"),
    ("imap", "folder", "configured", "mx.example.org", "", "secret", "EMAIL_USERNAME"),
    ("folder", "smtp", "", "", "user", "", "EMAIL_USERNAME"),
    ("imap", "smtp", "configured", "mx.example.org", "user", "secret", None),
    ("folder", "folder", "", "", "", "", None),
])
def test_live_settings_fail_before_mailbox_access(mailbox, sender, password, authserv, username, app_password, expected):
    settings = SimpleNamespace(email_mailbox=mailbox, email_sender=sender, imap_intake_allowed=bool(password),
        email_trusted_authserv_id=authserv, email_username=SecretStr(username), email_app_password=SecretStr(app_password))
    if expected:
        with pytest.raises(RuntimeError, match=expected):
            email_poller._validate_live_settings(settings)
    else:
        email_poller._validate_live_settings(settings)


@pytest.mark.parametrize("enabled,watch,failing", [(False, False, False), (True, False, False), (True, False, True), (True, True, True)])
def test_poller_cli_exit_and_watch_recovery(inbox, monkeypatch, enabled, watch, failing):
    settings = get_settings()
    monkeypatch.setattr(settings, "email_intake_enabled", enabled)
    monkeypatch.setattr(sys, "argv", ["email-poller", "--watch" if watch else "--once"])
    monkeypatch.setattr(email_poller, "configure_logging", Mock())
    poll = Mock(side_effect=[email_poller.IncompletePoll("retry required"), 2] if failing else [2])
    monkeypatch.setattr(email_poller, "poll_once", poll)
    class StopWatch(Exception):
        pass
    pauses = []
    def sleep(interval):
        pauses.append(interval)
        if len(pauses) == 2:
            raise StopWatch
    monkeypatch.setattr(email_poller.time, "sleep", sleep)
    if enabled and watch:
        with pytest.raises(StopWatch):
            email_poller.main()
        assert poll.call_count == 2
        assert pauses == [settings.email_poll_interval_seconds] * 2
    elif enabled and failing:
        with pytest.raises(SystemExit) as error:
            email_poller.main()
        assert error.value.code == 1
    else:
        email_poller.main()
        assert poll.call_count == int(enabled)


def test_mailbox_outage_still_prunes_and_retries_pending_reply(client, db_session, inbox, monkeypatch):
    old = models.IntakeMessage(message_key="a" * 64, received_at=datetime.now(timezone.utc),
        handled_at=datetime.now(timezone.utc) - timedelta(days=1000), outcome=models.IntakeMessageOutcome.unknown_sender,
        reply_status=models.IntakeReplyStatus.none)
    pending = models.IntakeMessage(message_key="b" * 64, received_at=datetime.now(timezone.utc),
        sender_address="team@example.org", sender_label="Lab", outcome=models.IntakeMessageOutcome.no_pdf,
        reply_status=models.IntakeReplyStatus.pending, reason="Attach a PDF.")
    db_session.add_all([old, pending])
    db_session.commit()
    old_id, pending_id = old.id, pending.id
    def unavailable(_):
        raise OSError("synthetic mailbox outage")
    monkeypatch.setattr(email_poller, "create_mailbox", unavailable)
    with pytest.raises(email_poller.IncompletePoll):
        email_poller.poll_once()
    db_session.expire_all()
    assert db_session.get(models.IntakeMessage, old_id) is None
    assert db_session.get(models.IntakeMessage, pending_id).reply_status == models.IntakeReplyStatus.sent
    assert len(replies(inbox)) == 1


def test_reply_stops_after_three_failures(db_session, inbox, monkeypatch):
    row = models.IntakeMessage(message_key="c" * 64, received_at=datetime.now(timezone.utc),
        sender_address="team@example.org", sender_label="Lab", outcome=models.IntakeMessageOutcome.no_pdf,
        reply_status=models.IntakeReplyStatus.pending)
    db_session.add(row)
    db_session.commit()
    send = Mock(side_effect=OSError("synthetic sender outage"))
    monkeypatch.setattr(email_poller, "create_sender", lambda _: SimpleNamespace(send=send))
    for _ in range(4):
        email_poller._send_replies(get_settings())
    db_session.refresh(row)
    assert row.reply_attempts == send.call_count == 3
    assert row.reply_status == models.IntakeReplyStatus.failed


def test_missing_admin_resources_and_empty_report_state(client, inbox):
    missing = str(uuid.uuid4())
    assert client.patch(f"/email-intake/allowed-senders/{missing}", json={"label": "Lab"}).status_code == 404
    assert client.delete(f"/email-intake/allowed-senders/{missing}").status_code == 404
    assert client.get(f"/email-intake/held/{missing}/file").status_code == 404
    assert client.post(f"/email-intake/held/{missing}/release").status_code == 404
    assert client.get(f"/reports/{missing}/intake-state").status_code == 404
    assert client.get("/email-intake/allowed-senders").json() == []
    report_id = client.post("/reports", json={}).json()["id"]
    state = client.get(f"/reports/{report_id}/intake-state").json()
    assert state["attachment_id"] is None and state["source"] is None
    assert not state["translation_required"] and all(value is None for value in state["latest_jobs"].values())


@pytest.mark.parametrize("damage", ["missing_path", "missing_file"])
def test_held_file_missing_storage_is_404(client, db_session, inbox, damage):
    client.post("/email-intake/allowed-senders", json={"kind": "address", "value": "flow-team@example.org", "label": "Lab"})
    write_mail(inbox, "held.eml", message(pdf("Needs human review")))
    assert email_poller.poll_once() == 1
    row = db_session.scalar(select(models.IntakeFile))
    if damage == "missing_path":
        row.held_path = None
        db_session.commit()
    else:
        intake.held_path(row).unlink()
    assert client.get(f"/email-intake/held/{row.id}/file").status_code == 404
    assert client.post(f"/email-intake/held/{row.id}/release").status_code == 404
    assert client.delete(f"/email-intake/held/{row.id}").status_code == 404


def test_non_pdf_and_repeated_pdf_have_bounded_outcomes(client, db_session, inbox):
    client.post("/email-intake/allowed-senders", json={"kind": "address", "value": "flow-team@example.org", "label": "Lab"})
    data = pdf("Check this document")
    write_mail(inbox, "repeated.eml", message(data, data))
    write_mail(inbox, "non-pdf.eml", message(b"ordinary text", message_id="<nonpdf@example.org>"))
    assert email_poller.poll_once() == 2
    rows = db_session.scalars(select(models.IntakeFile).order_by(models.IntakeFile.reason_code)).all()
    assert sorted(row.reason_code for row in rows) == ["already_in_message", "unsupported_type", "unsure"]
    logs = client.get("/email-intake/log").json()["items"]
    assert {row["outcome"] for row in logs} == {"processed", "no_pdf"}
    assert len(client.get("/email-intake/held").json()) == 1
    assert client.get("/reports").json() == []


def test_hourly_limit_does_not_store_or_answer_rate_limited_sender(client, db_session, inbox, monkeypatch):
    client.post("/email-intake/allowed-senders", json={"kind": "address", "value": "flow-team@example.org", "label": "Lab"})
    monkeypatch.setattr(get_settings(), "email_max_messages_per_sender_per_hour", 1)
    write_mail(inbox, "a.eml", message(message_id="<first@example.org>"))
    write_mail(inbox, "b.eml", message(message_id="<second@example.org>"))
    assert email_poller.poll_once() == 2
    limited = db_session.scalar(select(models.IntakeMessage).where(models.IntakeMessage.outcome == models.IntakeMessageOutcome.rate_limited))
    assert limited.sender_address is None and limited.reply_status == models.IntakeReplyStatus.none
    assert len(replies(inbox)) == 1


def test_mime_part_limit_is_visible_in_reply(client, inbox):
    client.post("/email-intake/allowed-senders", json={"kind": "address", "value": "flow-team@example.org", "label": "Lab"})
    write_mail(inbox, "many.eml", message(*([b"not pdf"] * 55)))
    assert email_poller.poll_once() == 1
    body = replies(inbox)[0].get_body(preferencelist=("plain",)).get_content()
    assert "too many parts" in body
    assert "Attachment 49:" not in body


def test_failed_held_release_rolls_back_and_cleans_staged_draft(client, db_session, inbox, monkeypatch):
    from app.routers import email_intake as routes
    client.post("/email-intake/allowed-senders", json={"kind": "address", "value": "flow-team@example.org", "label": "Lab"})
    write_mail(inbox, "held.eml", message(pdf("Needs review")))
    assert email_poller.poll_once() == 1
    item = db_session.scalar(select(models.IntakeFile))
    original_path = intake.held_path(item)
    response = client.get(f"/email-intake/held/{item.id}/file?inline=true")
    assert response.status_code == 200 and response.headers["content-disposition"].startswith("inline")
    real_create = intake.create_draft
    staged = []
    def fail_after_storage(db, row, contents, text, paths):
        real_create(db, row, contents, text, paths)
        staged.extend(paths)
        raise OSError("synthetic release failure")
    monkeypatch.setattr(routes.intake, "create_draft", fail_after_storage)
    with pytest.raises(OSError, match="release failure"):
        client.post(f"/email-intake/held/{item.id}/release")
    db_session.refresh(item)
    assert item.outcome == models.IntakeFileOutcome.held
    assert original_path.is_file() and staged and all(not path.exists() for path in staged)
    assert client.get("/reports").json() == []


def test_retry_orphan_and_prune_preserve_actionable_messages(db_session, inbox):
    old = datetime.now(timezone.utc) - timedelta(days=1000)
    messages = []
    for index, state in enumerate((None, models.IntakeReadState.waiting_for_limit, models.IntakeReadState.queued)):
        row = models.IntakeMessage(message_key=f"{index + 10:064x}", received_at=old, handled_at=old,
            outcome=models.IntakeMessageOutcome.processed, reply_status=models.IntakeReplyStatus.none)
        row.files.append(models.IntakeFile(position=1, size_bytes=0, outcome=models.IntakeFileOutcome.loaded,
            read_state=state, waiting_kind=models.ExtractionJobKind.classify if state == models.IntakeReadState.waiting_for_limit else None))
        messages.append(row)
    held = models.IntakeMessage(message_key="f" * 64, received_at=old, handled_at=old,
        outcome=models.IntakeMessageOutcome.processed, reply_status=models.IntakeReplyStatus.none)
    held.files.append(models.IntakeFile(position=1, size_bytes=0, outcome=models.IntakeFileOutcome.held))
    db_session.add_all(messages + [held])
    db_session.commit()
    ids = [row.id for row in messages]
    intake.prune_log(db_session, 90)
    db_session.commit()
    assert db_session.scalar(select(models.IntakeMessage.id).where(models.IntakeMessage.id == ids[0])) is None
    assert db_session.scalar(select(models.IntakeMessage.id).where(models.IntakeMessage.id == held.id)) is not None
    assert not intake.retry_waiting(db_session)
    db_session.commit()
    db_session.refresh(messages[1].files[0])
    assert messages[1].files[0].read_state == models.IntakeReadState.needs_person
    assert messages[1].files[0].waiting_kind is None
    intake.prune_log(db_session, 90)
    db_session.commit()
    assert db_session.scalar(select(models.IntakeMessage.id).where(models.IntakeMessage.id == ids[1])) is None
    assert db_session.scalar(select(models.IntakeMessage.id).where(models.IntakeMessage.id == ids[2])) is not None


def test_queue_reuses_pending_job_and_requires_person_after_failed_attempts(client, db_session, inbox, monkeypatch):
    from tests.test_email_intake import service_pdf
    client.post("/email-intake/allowed-senders", json={"kind": "address", "value": "flow-team@example.org", "label": "Lab"})
    write_mail(inbox, "report.eml", message(service_pdf()))
    assert email_poller.poll_once() == 1
    row = db_session.scalar(select(models.IntakeFile))
    attachment = row.report.attachments[0]
    assert not intake.queue_read(db_session, row, attachment, models.ExtractionJobKind.classify)
    db_session.commit()
    jobs = db_session.scalars(select(models.ExtractionJob)).all()
    assert len(jobs) == 1 and row.read_state == models.IntakeReadState.queued
    jobs[0].status = models.ExtractionJobStatus.failed
    monkeypatch.setattr(get_settings(), "max_failed_attempts_per_attachment", 1)
    db_session.commit()
    assert not intake.queue_read(db_session, row, attachment, models.ExtractionJobKind.classify)
    db_session.commit()
    assert row.read_state == models.IntakeReadState.needs_person and row.waiting_kind is None
    assert len(db_session.scalars(select(models.ExtractionJob)).all()) == 1


def test_retry_waits_at_daily_capacity_without_adding_jobs(client, db_session, inbox, monkeypatch):
    from tests.test_email_intake import service_pdf
    client.post("/email-intake/allowed-senders", json={"kind": "address", "value": "flow-team@example.org", "label": "Lab"})
    monkeypatch.setattr(get_settings(), "daily_job_cap", 1)
    write_mail(inbox, "reports.eml", message(service_pdf(), service_pdf() + b"\n"))
    assert email_poller.poll_once() == 1
    waiting = db_session.scalar(select(models.IntakeFile).where(models.IntakeFile.read_state == models.IntakeReadState.waiting_for_limit))
    assert waiting is not None
    assert not intake.retry_waiting(db_session)
    db_session.commit()
    db_session.refresh(waiting)
    assert waiting.read_state == models.IntakeReadState.waiting_for_limit
    assert waiting.waiting_kind == models.ExtractionJobKind.classify
    assert len(db_session.scalars(select(models.ExtractionJob)).all()) == 1
