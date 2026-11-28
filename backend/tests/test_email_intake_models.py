"""Database-enforced replay, privacy and provenance contracts for email intake."""
from datetime import datetime, timezone

import pytest
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app.models import (
    ExtractionJobKind,
    IntakeAllowEntry,
    IntakeAllowKind,
    IntakeFile,
    IntakeFileOutcome,
    IntakeMessage,
    IntakeMessageOutcome,
    IntakeReadState,
    IntakeReplyStatus,
    Report,
    ReportSource,
    ReportSourceChannel,
)

NOW = datetime(2026, 11, 26, tzinfo=timezone.utc)
ADDRESS = "sender@example.test"


def message(**overrides):
    values = dict(message_key="a" * 64, received_at=NOW, outcome=IntakeMessageOutcome.processed,
                  sender_address=ADDRESS, sender_label="Lab team")
    return IntakeMessage(**(values | overrides))


def file_row(parent, **overrides):
    return IntakeFile(**(dict(message=parent, position=1, outcome=IntakeFileOutcome.loaded,
                            size_bytes=42) | overrides))


def test_replay_message_key_is_unique(db_session):
    db_session.add(message())
    db_session.commit()
    db_session.add(message())
    with pytest.raises(IntegrityError, match="uq_intake_messages_message_key"):
        db_session.commit()
    db_session.rollback()
    assert len(db_session.scalars(select(IntakeMessage)).all()) == 1


def test_attachment_position_is_unique_per_message(db_session):
    parent = message()
    db_session.add_all([file_row(parent), file_row(parent)])
    with pytest.raises(IntegrityError, match="uq_intake_files_message_position"):
        db_session.commit()
    db_session.rollback()


@pytest.mark.parametrize("outcome", [IntakeMessageOutcome.unknown_sender, IntakeMessageOutcome.sender_not_verified])
def test_unknown_and_unverified_senders_cannot_store_addresses(db_session, outcome):
    db_session.add(message(outcome=outcome))
    with pytest.raises(IntegrityError, match="ck_intake_messages_no_address_for_unknown"):
        db_session.commit()
    db_session.rollback()
    db_session.add(message(outcome=outcome, sender_address=None, sender_label=None))
    db_session.commit()


@pytest.mark.parametrize("overrides,constraint", [
    ({"message_key": "A" * 64}, "message_key_sha256"),
    ({"message_key": "bad"}, "message_key_sha256"),
    ({"sender_label": None}, "sender_pair"),
    ({"sender_address": None, "sender_label": None, "reply_status": IntakeReplyStatus.pending}, "reply_needs_address"),
    ({"reply_sent_at": NOW}, "reply_sent_at"),
    ({"file_count": -1}, "counts_not_negative"),
    ({"files_skipped": -1}, "counts_not_negative"),
    ({"reply_attempts": -1}, "counts_not_negative"),
])
def test_message_constraints(db_session, overrides, constraint):
    db_session.add(message(**overrides))
    with pytest.raises(IntegrityError, match=constraint):
        db_session.commit()
    db_session.rollback()


@pytest.mark.parametrize("overrides,constraint", [
    ({"position": 0}, "position_positive"),
    ({"size_bytes": -1}, "size_not_negative"),
    ({"page_count": -1}, "page_count_not_negative"),
    ({"content_sha256": "bad"}, "content_sha256"),
    ({"held_path": "email-held/test.pdf"}, "held_path_only_held"),
    ({"waiting_kind": ExtractionJobKind.extract}, "waiting_kind"),
    ({"waiting_kind": ExtractionJobKind.extract, "read_state": IntakeReadState.queued}, "waiting_kind"),
])
def test_file_constraints(db_session, overrides, constraint):
    db_session.add(file_row(message(), **overrides))
    with pytest.raises(IntegrityError, match=constraint):
        db_session.commit()
    db_session.rollback()


def test_waiting_file_reuses_existing_job_kind(db_session):
    row = file_row(message(), waiting_kind=ExtractionJobKind.extract,
                   read_state=IntakeReadState.waiting_for_limit)
    db_session.add(row)
    db_session.commit()
    assert row.waiting_kind is ExtractionJobKind.extract


def source_graph(db):
    entry = IntakeAllowEntry(kind=IntakeAllowKind.address, value=ADDRESS, label="Lab team")
    report = Report()
    attachment = file_row(message(), report=report)
    source = ReportSource(report=report, channel=ReportSourceChannel.email, sender_address=ADDRESS,
                          sender_label=entry.label, received_at=NOW, intake_file=attachment)
    db.add_all([entry, source])
    db.commit()
    return entry.id, report.id, attachment.message_id, attachment.id


def test_provenance_survives_allow_list_edits_and_log_pruning(db_session):
    entry_id, report_id, message_id, file_id = source_graph(db_session)
    entry = db_session.get(IntakeAllowEntry, entry_id)
    entry.label = "Renamed team"
    db_session.commit()
    db_session.delete(entry)
    # Core delete exercises the database cascade with no ORM assistance.
    db_session.execute(delete(IntakeMessage).where(IntakeMessage.id == message_id))
    db_session.commit()
    db_session.expire_all()
    assert db_session.get(IntakeFile, file_id) is None
    source = db_session.get(Report, report_id).source
    assert source.sender_address == ADDRESS
    assert source.sender_label == "Lab team"
    assert source.received_at == NOW
    assert source.intake_file_id is None


@pytest.mark.parametrize("orm_delete", [True, False])
def test_report_delete_removes_source_but_preserves_intake_log(db_session, orm_delete):
    _, report_id, message_id, file_id = source_graph(db_session)
    if orm_delete:
        db_session.delete(db_session.get(Report, report_id))
    else:
        db_session.execute(delete(Report).where(Report.id == report_id))
    db_session.commit()
    db_session.expire_all()
    assert db_session.get(ReportSource, report_id) is None
    assert db_session.get(IntakeFile, file_id).report_id is None
    assert db_session.get(IntakeMessage, message_id) is not None


def test_email_source_requires_copied_sender(db_session):
    db_session.add(ReportSource(report=Report(), channel=ReportSourceChannel.email, received_at=NOW))
    with pytest.raises(IntegrityError, match="email_has_sender"):
        db_session.commit()
    db_session.rollback()


def test_allow_list_values_are_unique(db_session):
    db_session.add(IntakeAllowEntry(kind=IntakeAllowKind.address, value=ADDRESS, label="Lab team"))
    db_session.commit()
    db_session.add(IntakeAllowEntry(kind=IntakeAllowKind.address, value=ADDRESS, label="Other team"))
    with pytest.raises(IntegrityError, match="uq_intake_allow_entries_value"):
        db_session.commit()
    db_session.rollback()


@pytest.mark.parametrize("kind,value,label,constraint", [
    (IntakeAllowKind.address, "Sender@example.test", "Lab team", "value_lower"),
    (IntakeAllowKind.domain, ADDRESS, "Lab team", "kind_matches_value"),
    (IntakeAllowKind.address, "example.test", "Lab team", "kind_matches_value"),
    (IntakeAllowKind.domain, "example.test", "  ", "label_not_blank"),
])
def test_allow_list_constraints(db_session, kind, value, label, constraint):
    db_session.add(IntakeAllowEntry(kind=kind, value=value, label=label))
    with pytest.raises(IntegrityError, match=constraint):
        db_session.commit()
    db_session.rollback()
