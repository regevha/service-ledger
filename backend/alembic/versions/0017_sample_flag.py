"""is_sample on reports, instruments, instrument models and places (the first-run sample)

A new user can open a sample report on the New report screen (services/samples.py). Its report,
demo instrument and demo place carry this flag so every list, count and export of real data can
leave them out. Existing rows are real data: the flag starts false for all of them. Downgrade
first deletes any sample rows (they hold no real data: the report, its scan rows and jobs, the
instrument, its model record, the places), then drops the columns. A sample's scan file on disk stays as an orphan.

Revision ID: 0017_sample_flag
Revises: 0016_relative_attachment_paths
Create Date: 2026-11-20 01:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0017_sample_flag'
down_revision: Union[str, None] = '0016_relative_attachment_paths'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = ('reports', 'instruments', 'instrument_models', 'places')


def upgrade() -> None:
    for table in _TABLES:
        op.add_column(table, sa.Column('is_sample', sa.Boolean(), server_default=sa.text('false'), nullable=False))


def downgrade() -> None:
    bind = op.get_bind()
    sample_attachments = "SELECT id FROM attachments WHERE report_id IN (SELECT id FROM reports WHERE is_sample)"
    bind.execute(sa.text(f"DELETE FROM translations WHERE attachment_id IN ({sample_attachments})"))
    bind.execute(sa.text(f"DELETE FROM extraction_jobs WHERE attachment_id IN ({sample_attachments})"))
    bind.execute(sa.text("DELETE FROM attachments WHERE report_id IN (SELECT id FROM reports WHERE is_sample)"))
    bind.execute(sa.text("DELETE FROM reports WHERE is_sample"))
    bind.execute(sa.text("DELETE FROM instruments WHERE is_sample"))
    bind.execute(sa.text("DELETE FROM instrument_models WHERE is_sample"))
    bind.execute(sa.text("DELETE FROM places WHERE is_sample AND parent_id IS NOT NULL"))
    bind.execute(sa.text("DELETE FROM places WHERE is_sample"))
    for table in reversed(_TABLES):
        op.drop_column(table, 'is_sample')
