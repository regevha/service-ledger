"""Fixed-message-ID reply adapters; folder writes are idempotent, SMTP is at least once."""
from __future__ import annotations

import hashlib
import os
import smtplib
import ssl
import tempfile
from email.message import EmailMessage
from email.policy import SMTP
from pathlib import Path
from typing import Protocol

from app.config import Settings


def _message(from_address: str, to: str, subject: str, body: str, message_id: str) -> EmailMessage:
    message = EmailMessage(policy=SMTP)
    message['From'] = from_address
    message['To'] = to
    message['Subject'] = subject
    # Hash untrusted keys into a deterministic valid Message-ID with no header injection.
    key = hashlib.sha256(message_id.encode('utf-8')).hexdigest()
    message['Message-ID'] = f'<{key}@service-ledger.invalid>'
    message['Auto-Submitted'] = 'auto-replied'
    message.set_content(body)
    return message


class Sender(Protocol):
    def send(self, to: str, subject: str, body: str, message_id: str) -> None: ...


class FolderSender:
    def __init__(self, directory: str | Path, from_address: str):
        self.directory = Path(directory)
        self.from_address = from_address

    def send(self, to: str, subject: str, body: str, message_id: str) -> None:
        message = _message(self.from_address, to, subject, body, message_id)
        self.directory.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha256(message_id.encode('utf-8')).hexdigest()
        # Publish only a complete file; a retry or concurrent send cannot replace it.
        with tempfile.NamedTemporaryFile(dir=self.directory, delete=False) as output:
            temporary = Path(output.name)
            try:
                output.write(message.as_bytes())
                output.flush()
                os.fsync(output.fileno())
                try:
                    os.link(temporary, self.directory / f'{key}.eml')
                except FileExistsError:
                    pass
            finally:
                temporary.unlink(missing_ok=True)


class SmtpSender:
    def __init__(self, settings: Settings):
        self.settings = settings

    def send(self, to: str, subject: str, body: str, message_id: str) -> None:
        settings = self.settings
        message = _message(settings.email_intake_address, to, subject, body, message_id)
        try:
            with smtplib.SMTP_SSL(settings.email_smtp_host, settings.email_smtp_port,
                                  context=ssl.create_default_context(), timeout=30) as client:
                client.login(settings.email_username.get_secret_value(), settings.email_app_password.get_secret_value())
                client.send_message(message)
        except Exception:
            raise RuntimeError('mail delivery failed') from None


def create_sender(settings: Settings) -> FolderSender | SmtpSender:
    if settings.email_sender == 'folder':
        return FolderSender(settings.email_fake_outbox_dir, settings.email_intake_address)
    return SmtpSender(settings)
