"""reports keep what was first read from the document

`extracted_fields` is overwritten as a person corrects it, so once a report is saved there is no
way to tell what the reading got right. `original_fields` is a copy taken when the reading
finishes and never touched again; the Home screen compares the two to show how much of the
reading needed no edit. Reports read before this migration have none and are left out of that
figure.

Revision ID: 0010_report_original_fields
Revises: 0009_flow_cytometer_type_key
Create Date: 2026-11-07 17:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0010_report_original_fields'
down_revision: Union[str, None] = '0009_flow_cytometer_type_key'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('reports', sa.Column('original_fields', postgresql.JSONB(astext_type=sa.Text()), nullable=True))


def downgrade() -> None:
    op.drop_column('reports', 'original_fields')
