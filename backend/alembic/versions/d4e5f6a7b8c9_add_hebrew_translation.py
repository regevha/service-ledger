"""add translations, translate jobs, and report issuer / type note

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-10-15 22:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'd4e5f6a7b8c9'
down_revision: Union[str, None] = 'c3d4e5f6a7b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # New enum values cannot be added inside a transaction block on older
    # Postgres, nor used until committed — hence the autocommit block.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE extraction_job_kind ADD VALUE IF NOT EXISTS 'translate'")
        op.execute("ALTER TYPE extraction_job_status ADD VALUE IF NOT EXISTS 'translating'")

    translation_status = postgresql.ENUM(
        'pending_review', 'accepted', 'discarded', 'superseded', 'not_needed',
        name='translation_status', create_type=False,
    )
    translation_status.create(op.get_bind(), checkfirst=True)

    op.create_table(
        'translations',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('attachment_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('attachments.id'), nullable=False),
        sa.Column('status', translation_status, nullable=False),
        sa.Column('source_language', sa.String(), nullable=False),
        sa.Column('hebrew_share', sa.Float(), nullable=True),
        sa.Column('model_text', sa.Text(), nullable=True),
        sa.Column('accepted_text', sa.Text(), nullable=True),
        sa.Column('ignored_pages', postgresql.JSONB(), nullable=False, server_default='[]'),
        sa.Column('included_pages', postgresql.JSONB(), nullable=False, server_default='[]'),
        sa.Column('identifier_check', postgresql.JSONB(), nullable=False, server_default='{}'),
        sa.Column('notes', postgresql.JSONB(), nullable=False, server_default='[]'),
        sa.Column('reader', sa.String(), nullable=False, server_default='model'),
        sa.Column('model', sa.String(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_translations_attachment_id', 'translations', ['attachment_id'])

    op.add_column('extraction_jobs', sa.Column('params', postgresql.JSONB(), nullable=True))
    op.add_column('reports', sa.Column('issuer', sa.String(), nullable=True))
    op.add_column('reports', sa.Column('report_type_note', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('reports', 'report_type_note')
    op.drop_column('reports', 'issuer')
    op.drop_column('extraction_jobs', 'params')
    op.drop_index('ix_translations_attachment_id', table_name='translations')
    op.drop_table('translations')
    op.execute("DROP TYPE IF EXISTS translation_status")

    # Postgres cannot drop a single enum value: rebuild both types without the
    # new ones, refusing while any job still uses them.
    bind = op.get_bind()
    in_use = bind.exec_driver_sql(
        "SELECT count(*) FROM extraction_jobs WHERE kind = 'translate' OR status = 'translating'"
    ).scalar()
    if in_use:
        raise RuntimeError(
            f"Cannot downgrade: {in_use} extraction job(s) are translate jobs or are translating. "
            "Delete them first."
        )
    op.execute("ALTER TYPE extraction_job_kind RENAME TO extraction_job_kind_old")
    op.execute("CREATE TYPE extraction_job_kind AS ENUM ('classify', 'extract')")
    op.execute("ALTER TABLE extraction_jobs ALTER COLUMN kind DROP DEFAULT")
    op.execute(
        "ALTER TABLE extraction_jobs ALTER COLUMN kind TYPE extraction_job_kind "
        "USING kind::text::extraction_job_kind"
    )
    op.execute("ALTER TABLE extraction_jobs ALTER COLUMN kind SET DEFAULT 'extract'")
    op.execute("DROP TYPE extraction_job_kind_old")
    op.execute("ALTER TYPE extraction_job_status RENAME TO extraction_job_status_old")
    op.execute("CREATE TYPE extraction_job_status AS ENUM ('pending', 'classifying', 'extracting', 'succeeded', 'failed')")
    op.execute("ALTER TABLE extraction_jobs ALTER COLUMN status DROP DEFAULT")
    op.execute(
        "ALTER TABLE extraction_jobs ALTER COLUMN status TYPE extraction_job_status "
        "USING status::text::extraction_job_status"
    )
    op.execute("DROP TYPE extraction_job_status_old")
