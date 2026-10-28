"""prompt preview: job status awaiting_approval and extraction_jobs.prompt_preview

Debug aid (VIEW_PROMPTS): a job can stop before its Claude call so a person reads
the prompt and presses Send or Cancel. Adds the status value and the column that
holds the prompt. The downgrade drops the column; Postgres cannot drop an enum
value, so the value stays (harmless).

Revision ID: 0004_prompt_preview
Revises: 0003_drop_place_text
Create Date: 2026-10-28 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0004_prompt_preview'
down_revision: Union[str, None] = '0003_drop_place_text'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE extraction_job_status ADD VALUE IF NOT EXISTS 'awaiting_approval'")
    op.add_column("extraction_jobs", sa.Column("prompt_preview", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("extraction_jobs", "prompt_preview")
