"""extraction_jobs get a heartbeat_at column

Worker crash recovery used to fail every in-progress job at worker startup,
which is only safe with exactly one worker: a second worker or replica starting
up would fail the jobs the first one was still running. The worker that holds a
job now refreshes this column every few seconds, and recovery only fails jobs
whose beat is missing or stale. Existing rows get NULL, which recovery treats as
stale, so a job already stuck when this ships is still cleaned up. Downgrade
drops the column.

Revision ID: 0013_job_heartbeat
Revises: 0012_attachment_filename
Create Date: 2026-11-12 17:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0013_job_heartbeat'
down_revision: Union[str, None] = '0012_attachment_filename'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('extraction_jobs', sa.Column('heartbeat_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('extraction_jobs', 'heartbeat_at')
