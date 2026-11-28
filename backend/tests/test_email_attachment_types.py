"""Email intake only looks at attachment types the reading step can read (PDF).

The type is decided from the file's bytes. The file name and the declared
content type are claims by the sender and never grant anything.
"""
from __future__ import annotations

from email.message import EmailMessage

import pytest
from sqlalchemy import select

from app import email_poller, models
from app.config import get_settings
from app.services.attachment_types import (
    REASON_MISMATCH,
    REASON_UNSUPPORTED,
    classify_attachment,
    detect_type,
)
from tests import test_email_intake as email_helpers
from tests.test_email_intake import SENDER, pdf, replies, write_mail

inbox = email_helpers.inbox
allow_sender = email_helpers.allow_sender

EXE = b"MZ\x90\x00\x03\x00\x00\x00" + b"\x00" * 64
ZIP = b"PK\x03\x04" + b"\x00" * 32
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
HTML = b"  <!DOCTYPE html><html><script>alert(1)</script></html>"


@pytest.mark.parametrize(
    "data, expected",
    [
        (b"%PDF-1.7\n", "pdf"),
        (EXE, "executable"),
        (b"\x7fELF\x02\x01", "executable"),
        (ZIP, "zip"),
        (PNG, "image"),
        (HTML, "html"),
        (b"#!/bin/sh\nrm -rf /", "script"),
        (b"plain words", "text"),
        (b"abc\x00def", "binary"),
        (b"", "empty"),
        # The PDF header must be the first bytes; leading junk is not a PDF.
        (b"junk%PDF-1.7\n", "text"),
    ],
)
def test_type_comes_from_the_bytes(data, expected):
    assert detect_type(data) == expected


@pytest.mark.parametrize("declared", ["", "application/pdf", "application/x-pdf", "application/octet-stream"])
def test_pdf_with_ordinary_declared_type_is_supported(declared):
    verdict = classify_attachment(b"%PDF-1.7\n", declared)
    assert verdict.supported and verdict.reason_code is None


@pytest.mark.parametrize("declared", ["image/png", "text/plain", "application/zip", "message/rfc822", "text/html"])
def test_pdf_declared_as_something_else_is_a_mismatch(declared):
    verdict = classify_attachment(b"%PDF-1.7\n", declared)
    assert not verdict.supported and verdict.reason_code == REASON_MISMATCH


@pytest.mark.parametrize("data", [EXE, ZIP, PNG, HTML, b"words", b""])
@pytest.mark.parametrize("declared", ["application/pdf", "image/png", ""])
def test_a_pdf_content_type_never_makes_another_file_supported(data, declared):
    verdict = classify_attachment(data, declared)
    assert not verdict.supported and verdict.reason_code == REASON_UNSUPPORTED


def test_classifier_never_raises_on_odd_input():
    for data in (None, 12, "text", object()):
        assert not classify_attachment(data, "application/pdf").supported  # type: ignore[arg-type]


def build(*parts, message_id="<types@example.org>"):
    mail = EmailMessage()
    mail["From"] = SENDER
    mail["To"] = "intake@example.invalid"
    mail["Message-ID"] = message_id
    mail["Subject"] = "Files"
    mail.set_content("See attached.")
    for data, maintype, subtype, name in parts:
        mail.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)
    return mail.as_bytes()


def intake_files(db_session):
    db_session.expire_all()
    return db_session.scalars(select(models.IntakeFile).order_by(models.IntakeFile.position)).all()


def test_only_readable_types_are_processed_and_the_rest_is_recorded(client, db_session, inbox, allow_sender):
    raw = build(
        (EXE, "application", "pdf", "report.pdf"),          # disguised executable
        (ZIP, "application", "zip", "reports.zip"),          # archive
        (pdf("Check this document"), "image", "png", "scan.png"),  # PDF bytes, wrong declared type
        (pdf("Check this document"), "application", "pdf", "real.pdf"),
    )
    write_mail(inbox, "mixed.eml", raw)
    assert email_poller.poll_once() == 1

    files = intake_files(db_session)
    assert [f.reason_code for f in files] == ["unsupported_type", "unsupported_type", "type_mismatch", "unsure"]
    for refused in files[:3]:
        assert refused.outcome == models.IntakeFileOutcome.refused
        # Not hashed, not parsed, not kept: nothing of the file was stored.
        assert refused.content_sha256 is None and refused.held_path is None and refused.report_id is None
        assert refused.page_count is None
    assert files[3].outcome == models.IntakeFileOutcome.held
    assert client.get("/reports").json() == []
    stored = list((get_settings().attachment_storage_path / "email-held").glob("*"))
    assert len(stored) == 1

    body = replies(inbox)[0].get_body(preferencelist=("plain",)).get_content()
    assert "PDF files only" in body
    assert "does not match" in body


def test_message_with_only_unsupported_files_is_no_pdf(client, db_session, inbox, allow_sender):
    write_mail(inbox, "none.eml", build((EXE, "application", "octet-stream", "tool.exe"), (HTML, "text", "html", "page.html")))
    assert email_poller.poll_once() == 1
    message = db_session.scalar(select(models.IntakeMessage))
    assert message.outcome == models.IntakeMessageOutcome.no_pdf
    assert {f.reason_code for f in intake_files(db_session)} == {"unsupported_type"}
    assert client.get("/reports").json() == []


def test_unsupported_files_are_capped_per_message(client, db_session, inbox, allow_sender, monkeypatch):
    monkeypatch.setattr(get_settings(), "email_max_other_files_per_message", 2)
    junk = [(EXE, "application", "octet-stream", f"f{i}.bin") for i in range(5)]
    write_mail(inbox, "junk.eml", build(*junk, (pdf("Check this document"), "application", "pdf", "real.pdf")))
    assert email_poller.poll_once() == 1
    message = db_session.scalar(select(models.IntakeMessage))
    db_session.refresh(message)
    assert message.files_skipped == 3
    codes = [f.reason_code for f in intake_files(db_session)]
    assert codes.count("unsupported_type") == 2 and "unsure" in codes
    body = replies(inbox)[0].get_body(preferencelist=("plain",)).get_content()
    assert "exceeded the file count limit: 3" in body
