"""email intake: allow list, message log, attachment outcomes and report sources

Adds the four tables of docs/features/email-intake/DATA_MODEL.md, so the worker can read
reports sent by email:
- intake_allow_entries: the addresses and domains that may send reports, each with a team
  or role label. Edited by admins; nothing is seeded.
- intake_messages: one row per email the worker handled, for the admin log and to stop the
  same email being handled twice. It never holds the body, subject or raw Message-ID, and
  holds an address only for allowed senders (CHECK constraints enforce that).
- intake_files: one row per attachment, with its outcome. Held files are listed from it.
- report_sources: where a report came from (email, sender, label, time), kept beside the
  report rather than in a report field.

Five new enum types are created. The existing extraction_job_kind type is reused for
intake_files.waiting_kind and is not created or dropped here.

Only new tables: no existing table or row changes. Downgrade drops the four tables and the
five new enum types. On a database that has used email intake, that deletes the allow list,
the email log and the record of which reports came by email (the reports themselves stay).

Revision ID: 0017_email_intake
Revises: 0016_relative_attachment_paths
Create Date: 2026-11-13 15:40:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0017_email_intake'
down_revision: Union[str, None] = '0016_relative_attachment_paths'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


allow_kind = postgresql.ENUM('address', 'domain', name='intake_allow_kind', create_type=False)
message_outcome = postgresql.ENUM(
    'processed', 'unknown_sender', 'sender_not_verified', 'rate_limited', 'no_pdf', 'too_large',
    'auto_reply_ignored', 'error',
    name='intake_message_outcome', create_type=False,
)
reply_status = postgresql.ENUM('none', 'pending', 'sent', 'failed', name='intake_reply_status', create_type=False)
file_outcome = postgresql.ENUM(
    'loaded', 'needs_report_type', 'held', 'released', 'held_deleted', 'refused', 'duplicate',
    name='intake_file_outcome', create_type=False,
)
read_state = postgresql.ENUM('queued', 'waiting_for_limit', 'needs_person', name='intake_read_state', create_type=False)
source_channel = postgresql.ENUM('email', 'web', name='report_source_channel', create_type=False)
# Already exists (0001_baseline, extraction_jobs.kind): referenced only.
job_kind = postgresql.ENUM('classify', 'extract', 'translate', name='extraction_job_kind', create_type=False)

NEW_ENUMS = (allow_kind, message_outcome, reply_status, file_outcome, read_state, source_channel)

SHA256_HEX = "'^[0-9a-f]{64}$'"


def upgrade() -> None:
    bind = op.get_bind()
    for enum_type in NEW_ENUMS:
        enum_type.create(bind, checkfirst=False)

    op.create_table(
        'intake_allow_entries',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('kind', allow_kind, nullable=False),
        sa.Column('value', sa.String(length=254), nullable=False),
        sa.Column('label', sa.String(length=60), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint('value = lower(value)', name='ck_intake_allow_entries_value_lower'),
        sa.CheckConstraint(
            "(kind = 'address') = (strpos(value, '@') > 0)", name='ck_intake_allow_entries_kind_matches_value'
        ),
        sa.CheckConstraint('char_length(btrim(label)) > 0', name='ck_intake_allow_entries_label_not_blank'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('value', name='uq_intake_allow_entries_value'),
    )

    op.create_table(
        'intake_messages',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('message_key', sa.String(length=64), nullable=False),
        sa.Column('received_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('handled_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('sender_address', sa.String(length=254), nullable=True),
        sa.Column('sender_label', sa.String(length=60), nullable=True),
        sa.Column('outcome', message_outcome, nullable=False),
        sa.Column('reason', sa.String(length=200), nullable=True),
        sa.Column('file_count', sa.Integer(), server_default=sa.text('0'), nullable=False),
        sa.Column('files_skipped', sa.Integer(), server_default=sa.text('0'), nullable=False),
        sa.Column('reply_status', reply_status, server_default=sa.text("'none'"), nullable=False),
        sa.Column('reply_attempts', sa.Integer(), server_default=sa.text('0'), nullable=False),
        sa.Column('reply_sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(f'message_key ~ {SHA256_HEX}', name='ck_intake_messages_message_key_sha256'),
        sa.CheckConstraint('(sender_address IS NULL) = (sender_label IS NULL)', name='ck_intake_messages_sender_pair'),
        sa.CheckConstraint(
            "sender_address IS NULL OR outcome NOT IN ('unknown_sender', 'sender_not_verified')",
            name='ck_intake_messages_no_address_for_unknown',
        ),
        sa.CheckConstraint(
            "reply_status = 'none' OR sender_address IS NOT NULL", name='ck_intake_messages_reply_needs_address'
        ),
        sa.CheckConstraint("reply_sent_at IS NULL OR reply_status = 'sent'", name='ck_intake_messages_reply_sent_at'),
        sa.CheckConstraint(
            'file_count >= 0 AND files_skipped >= 0 AND reply_attempts >= 0',
            name='ck_intake_messages_counts_not_negative',
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('message_key', name='uq_intake_messages_message_key'),
    )
    op.create_index(op.f('ix_intake_messages_received_at'), 'intake_messages', ['received_at'], unique=False)
    op.create_index(
        'ix_intake_messages_sender_received', 'intake_messages', ['sender_address', 'received_at'], unique=False
    )
    op.create_index(
        'ix_intake_messages_reply_pending', 'intake_messages', ['handled_at'], unique=False,
        postgresql_where=sa.text("reply_status = 'pending'"),
    )

    op.create_table(
        'intake_files',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('message_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('outcome', file_outcome, nullable=False),
        sa.Column('reason_code', sa.String(length=40), nullable=True),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column('page_count', sa.Integer(), nullable=True),
        sa.Column('content_sha256', sa.String(length=64), nullable=True),
        sa.Column('report_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('held_path', sa.String(), nullable=True),
        sa.Column('read_state', read_state, nullable=True),
        sa.Column('waiting_kind', job_kind, nullable=True),
        sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint('position >= 1', name='ck_intake_files_position_positive'),
        sa.CheckConstraint('size_bytes >= 0', name='ck_intake_files_size_not_negative'),
        sa.CheckConstraint('page_count IS NULL OR page_count >= 0', name='ck_intake_files_page_count_not_negative'),
        sa.CheckConstraint(
            f'content_sha256 IS NULL OR content_sha256 ~ {SHA256_HEX}', name='ck_intake_files_content_sha256'
        ),
        sa.CheckConstraint("held_path IS NULL OR outcome = 'held'", name='ck_intake_files_held_path_only_held'),
        sa.CheckConstraint(
            "waiting_kind IS NULL OR read_state = 'waiting_for_limit'", name='ck_intake_files_waiting_kind'
        ),
        sa.ForeignKeyConstraint(['message_id'], ['intake_messages.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['report_id'], ['reports.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('message_id', 'position', name='uq_intake_files_message_position'),
    )
    op.create_index(op.f('ix_intake_files_report_id'), 'intake_files', ['report_id'], unique=False)
    op.create_index(
        'ix_intake_files_held', 'intake_files', ['created_at'], unique=False,
        postgresql_where=sa.text("outcome = 'held'"),
    )
    op.create_index(
        'ix_intake_files_waiting_for_limit', 'intake_files', ['created_at'], unique=False,
        postgresql_where=sa.text("read_state = 'waiting_for_limit'"),
    )

    op.create_table(
        'report_sources',
        sa.Column('report_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('channel', source_channel, nullable=False),
        sa.Column('sender_address', sa.String(length=254), nullable=True),
        sa.Column('sender_label', sa.String(length=60), nullable=True),
        sa.Column('received_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('intake_file_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.CheckConstraint(
            "channel <> 'email' OR (sender_address IS NOT NULL AND sender_label IS NOT NULL)",
            name='ck_report_sources_email_has_sender',
        ),
        sa.ForeignKeyConstraint(['report_id'], ['reports.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['intake_file_id'], ['intake_files.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('report_id'),
    )
    op.create_index(op.f('ix_report_sources_intake_file_id'), 'report_sources', ['intake_file_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_report_sources_intake_file_id'), table_name='report_sources')
    op.drop_table('report_sources')
    op.drop_index('ix_intake_files_waiting_for_limit', table_name='intake_files')
    op.drop_index('ix_intake_files_held', table_name='intake_files')
    op.drop_index(op.f('ix_intake_files_report_id'), table_name='intake_files')
    op.drop_table('intake_files')
    op.drop_index('ix_intake_messages_reply_pending', table_name='intake_messages')
    op.drop_index('ix_intake_messages_sender_received', table_name='intake_messages')
    op.drop_index(op.f('ix_intake_messages_received_at'), table_name='intake_messages')
    op.drop_table('intake_messages')
    op.drop_table('intake_allow_entries')

    bind = op.get_bind()
    for enum_type in reversed(NEW_ENUMS):
        enum_type.drop(bind, checkfirst=False)
