"""reports.checked_fields: which low-confidence fields the technician marked as checked

Lets a saved draft remember what was checked, so reopening it flags only the
fields that still need a look. A JSON list of field names ("report_date" for the
service date); empty for every existing report.

Revision ID: 0005_checked_fields
Revises: 0004_prompt_preview
Create Date: 2026-10-28 20:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0005_checked_fields'
down_revision: Union[str, None] = '0004_prompt_preview'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column("checked_fields", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
    )


def downgrade() -> None:
    op.drop_column("reports", "checked_fields")
