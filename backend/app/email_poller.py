"""Poll email independently of whether the document worker is running."""
from __future__ import annotations

import argparse
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select, text
from sqlalchemy.orm import selectinload

from app import models
from app.config import Settings, get_settings
from app.db import SessionLocal, engine
from app.job_trigger import notify_job_queued
from app.services.email_intake import (
    clean_paths,
    process_message,
    prune_log,
    reply_body,
    retry_waiting,
)
from app.services.mail_sender import create_sender
from app.services.mailbox import create_mailbox
from app.trace import configure_logging

logger = logging.getLogger(__name__)
_POLL_LOCK = 1502316810
_REPLY_SUBJECT = "ServiceLedger email intake"


class IncompletePoll(RuntimeError):
    """A poll left mail unprocessed on purpose so the next attempt can retry it."""


def _send_replies(settings: Settings) -> None:
    with SessionLocal() as db:
        pending = db.scalars(
            select(models.IntakeMessage)
            .where(models.IntakeMessage.reply_status == models.IntakeReplyStatus.pending)
            .options(selectinload(models.IntakeMessage.files))
            .order_by(models.IntakeMessage.handled_at, models.IntakeMessage.id)
            .limit(50)
        ).all()
        if not pending:
            return
        sender = create_sender(settings)
        domain = settings.email_intake_address.rsplit("@", 1)[-1] or "serviceledger.invalid"
        for message in pending:
            assert message.sender_address is not None  # Enforced by the pending-reply constraint.
            # A deterministic Message-ID makes a retry recognizable. SMTP itself
            # cannot guarantee exactly-once delivery after an ambiguous disconnect.
            message_id = f"<sl-intake-{message.message_key}@{domain}>"
            message.reply_attempts += 1
            try:
                sender.send(message.sender_address, _REPLY_SUBJECT, reply_body(message, settings.max_pdf_upload_bytes), message_id)
            except Exception:
                logger.warning("Email intake notification failed for message %s.", message.id)
                if message.reply_attempts >= 3:
                    message.reply_status = models.IntakeReplyStatus.failed
            else:
                message.reply_status = models.IntakeReplyStatus.sent
                message.reply_sent_at = datetime.now(timezone.utc)
            db.commit()


def _validate_live_settings(settings: Settings) -> None:
    if settings.email_mailbox == "imap":
        if not settings.shared_password:
            raise RuntimeError("Configure SHARED_PASSWORD before enabling a live inbox.")
        if not settings.email_trusted_authserv_id.strip():
            raise RuntimeError("Configure EMAIL_TRUSTED_AUTHSERV_ID before enabling a live inbox.")
    if settings.email_mailbox == "imap" or settings.email_sender == "smtp":
        if not settings.email_username.get_secret_value() or not settings.email_app_password.get_secret_value():
            raise RuntimeError("Configure EMAIL_USERNAME and EMAIL_APP_PASSWORD for the dedicated mailbox.")


def poll_once() -> int:
    """Return the number of messages committed and acknowledged in this pass."""
    settings = get_settings()
    if not settings.email_intake_enabled:
        return 0
    _validate_live_settings(settings)
    # A session-level lock survives per-message commits. The report worker uses
    # a different lock and is free to process committed jobs during a poll.
    with engine.connect() as lock:
        obtained = lock.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": _POLL_LOCK})
        lock.commit()
        if not obtained:
            return 0
        try:
            return _poll_mailbox(settings)
        finally:
            lock.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": _POLL_LOCK})
            lock.commit()


def _poll_mailbox(settings: Settings) -> int:
    handled = 0
    incomplete = False
    try:
        with create_mailbox(settings) as mailbox:
            for incoming in mailbox.fetch():
                paths: list[Path] = []
                commit_started = False
                try:
                    with SessionLocal() as db:
                        queued = process_message(db, incoming, settings, paths)
                        db.flush()
                        commit_started = True
                        db.commit()
                except Exception as exc:
                    # A broken connection can obscure a successful COMMIT.
                    # Keep the scan in that case and let replay consult the DB.
                    if not commit_started:
                        clean_paths(paths)
                    incomplete = True
                    logger.error("Email intake message was left in the mailbox (%s).", type(exc).__name__)
                    continue
                if queued:
                    notify_job_queued()
                try:
                    mailbox.acknowledge(incoming.ref)
                    handled += 1
                except Exception:
                    incomplete = True
                    logger.warning("A committed email could not be acknowledged. It will be retried.")
    except Exception as exc:
        incomplete = True
        logger.error("Email intake could not read the mailbox (%s).", type(exc).__name__)

    with SessionLocal() as db:
        queued = retry_waiting(db)
        prune_log(db, settings.email_log_retention_days)
        db.commit()
    if queued:
        notify_job_queued()
    _send_replies(settings)
    if incomplete:
        raise IncompletePoll("Email intake left one or more items for retry.")
    return handled


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="Check the mailbox once (default).")
    mode.add_argument("--watch", action="store_true", help="Poll continuously for local demos.")
    args = parser.parse_args()
    configure_logging("email-intake")
    settings = get_settings()
    if not settings.email_intake_enabled:
        logger.info("Email intake is disabled.")
        return
    while True:
        try:
            logger.info("Email intake poll handled %s message(s).", poll_once())
        except IncompletePoll as exc:
            logger.warning("%s", exc)
            if not args.watch:
                raise SystemExit(1) from None
        if not args.watch:
            return
        time.sleep(settings.email_poll_interval_seconds)


if __name__ == "__main__":
    main()
