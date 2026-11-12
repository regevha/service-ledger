"""indexes on the columns the app filters and joins on

Until now only the full-text index and a few lookup columns were indexed, so the list
of reports, the report-to-attachment join and the worker's claim query read whole tables.
This adds indexes on reports (instrument_id, template_id, status, report_date), on
attachments (report_id) and on extraction_jobs (attachment_id), and a partial index on
extraction_jobs that holds only pending jobs, which is what the worker's claim query
(oldest pending job first) reads. Only indexes are created: no data changes, and
downgrade drops them again.

Revision ID: 0013_indexes
Revises: 0012_attachment_filename
Create Date: 2026-11-12 17:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0013_indexes'
down_revision: Union[str, None] = '0012_attachment_filename'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(op.f('ix_reports_instrument_id'), 'reports', ['instrument_id'], unique=False)
    op.create_index(op.f('ix_reports_template_id'), 'reports', ['template_id'], unique=False)
    op.create_index(op.f('ix_reports_status'), 'reports', ['status'], unique=False)
    op.create_index(op.f('ix_reports_report_date'), 'reports', ['report_date'], unique=False)
    op.create_index(op.f('ix_attachments_report_id'), 'attachments', ['report_id'], unique=False)
    op.create_index(op.f('ix_extraction_jobs_attachment_id'), 'extraction_jobs', ['attachment_id'], unique=False)
    op.create_index(
        'ix_extraction_jobs_pending', 'extraction_jobs', ['started_at'], unique=False,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index('ix_extraction_jobs_pending', table_name='extraction_jobs', postgresql_where=sa.text("status = 'pending'"))
    op.drop_index(op.f('ix_extraction_jobs_attachment_id'), table_name='extraction_jobs')
    op.drop_index(op.f('ix_attachments_report_id'), table_name='attachments')
    op.drop_index(op.f('ix_reports_report_date'), table_name='reports')
    op.drop_index(op.f('ix_reports_status'), table_name='reports')
    op.drop_index(op.f('ix_reports_template_id'), table_name='reports')
    op.drop_index(op.f('ix_reports_instrument_id'), table_name='reports')
