"""add kind to extraction_jobs

Revision ID: c31a9f4d2b17
Revises: b009557efab0
Create Date: 2026-09-17 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c31a9f4d2b17'
down_revision: Union[str, None] = 'b009557efab0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

extraction_job_kind = sa.Enum('classify', 'extract', name='extraction_job_kind')


def upgrade() -> None:
    extraction_job_kind.create(op.get_bind(), checkfirst=True)
    # §3's background worker (app/worker.py) needs to know which service call
    # a pending row is for. Every job that predates this column was created
    # by the old inline classify-then-extract handler, where a row only ever
    # existed once extraction had already happened (or failed) — so 'extract'
    # is the correct backfill for existing rows, not a guess.
    op.add_column(
        'extraction_jobs',
        sa.Column('kind', extraction_job_kind, nullable=False, server_default='extract'),
    )
    op.alter_column('extraction_jobs', 'kind', server_default=None)


def downgrade() -> None:
    op.drop_column('extraction_jobs', 'kind')
    extraction_job_kind.drop(op.get_bind(), checkfirst=True)
