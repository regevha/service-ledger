"""Poll email independently of whether the document worker is running."""
from __future__ import annotations

import argparse
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import exists, select, text
from sqlalchemy.orm import selectinload

from app import models
from app.config import Settings, get_settings
from app.db import SessionLocal, engine
from app.job_trigger import notify_job_queued
from app.services.email_intake import (
    clean_paths,
    compose_receipt,
    process_message,
    prune_log,
    retry_waiting,
)
from app.services.mail_sender import create_sender
from app.services.mailbox import create_mailbox
from app.trace import configure_logging

logger = logging.getLogger(__name__)
_POLL_LOCK = 1502316810
_REPLY_SUBJECT = "ServiceLedger email intake"
_RECEIPT_WAIT_SECONDS = 8


class IncompletePoll(RuntimeError):
    """A poll left mail unprocessed on purpose so the next attempt can retry it."""


class PollInProgress(RuntimeError):
    """Another process holds the mailbox lock."""


def _clear_receipt_metadata(message: models.IntakeMessage) -> None:
    message.reply_subject = message.reply_to_message_id = None
    for entry in message.files:
        entry.receipt_filename = None


def _receipts_waiting_for_reading() -> bool:
    with SessionLocal() as db:
        return bool(db.scalar(select(exists().where(
            models.IntakeFile.message_id == models.IntakeMessage.id,
            models.IntakeMessage.reply_status == models.IntakeReplyStatus.pending,
            models.IntakeFile.read_state == models.IntakeReadState.queued,
        ))))


def _wait_for_receipt_details() -> None:
    # Give the worker one shared window per batch. Each check opens a fresh
    # transaction so a completed read is visible without holding a DB session idle.
    deadline = time.monotonic() + _RECEIPT_WAIT_SECONDS
    while _receipts_waiting_for_reading():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(0.5, remaining))


def _send_replies(settings: Settings) -> None:
    if settings.use_live_claude:
        _wait_for_receipt_details()
    with SessionLocal() as db:
        report_loader = selectinload(models.IntakeMessage.files).selectinload(models.IntakeFile.report)
        pending = db.scalars(
            select(models.IntakeMessage)
            .where(models.IntakeMessage.reply_status == models.IntakeReplyStatus.pending)
            .options(report_loader.selectinload(models.Report.template),
                     report_loader.selectinload(models.Report.instrument))
            .order_by(models.IntakeMessage.handled_at, models.IntakeMessage.id)
            .limit(50)
        ).all()
        if not pending:
            return
        sender = create_sender(settings)
        domain = settings.email_intake_address.rsplit("@", 1)[-1] or "serviceledger.invalid"
        for message in pending:
            assert message.sender_address is not None  # Enforced by the pending-reply constraint.
            if db.get(models.IntakeNotificationOptOut, message.sender_address) is not None:
                message.reply_status = models.IntakeReplyStatus.none
                _clear_receipt_metadata(message)
                db.commit()
                continue
            # A deterministic Message-ID makes a retry recognizable. SMTP itself
            # cannot guarantee exactly-once delivery after an ambiguous disconnect.
            message_id = f"<sl-intake-{message.message_key}@{domain}>"
            message.reply_attempts += 1
            try:
                subject = message.reply_subject or _REPLY_SUBJECT
                if message.reply_subject and not re.match(r"^re\s*:", subject, re.IGNORECASE):
                    subject = f"Re: {subject}"
                plain, html, unsubscribe = compose_receipt(message, settings)
                sender.send(message.sender_address, subject, plain, message_id, html=html,
                            parent_id=message.reply_to_message_id, unsubscribe=unsubscribe)
            except Exception:
                logger.warning("Email intake notification failed for message %s.", message.id)
                if message.reply_attempts >= 3:
                    message.reply_status = models.IntakeReplyStatus.failed
            else:
                message.reply_status = models.IntakeReplyStatus.sent
                message.reply_sent_at = datetime.now(timezone.utc)
            if message.reply_status != models.IntakeReplyStatus.pending:
                _clear_receipt_metadata(message)
            db.commit()


def _validate_live_settings(settings: Settings) -> None:
    if settings.email_mailbox == "imap":
        if not settings.imap_intake_allowed:
            raise RuntimeError("Configure SHARED_PASSWORD before enabling a live inbox.")
        if not settings.email_trusted_authserv_id.strip():
            raise RuntimeError("Configure EMAIL_TRUSTED_AUTHSERV_ID before enabling a live inbox.")
    if settings.email_mailbox == "imap" or settings.email_sender == "smtp":
        if not settings.email_username.get_secret_value() or not settings.email_app_password.get_secret_value():
            raise RuntimeError("Configure EMAIL_USERNAME and EMAIL_APP_PASSWORD for the dedicated mailbox.")


def poll_once(*, report_busy: bool = False) -> int:
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
            if report_busy:
                raise PollInProgress
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
