"""reports keep where the model says it read each value on a scan or photo

A scan or photo has no text layer to search, so the extraction call also asks the model for a box
around each value. `field_boxes` is {"attachment_id": ..., "boxes": {field: {page, x, y, w, h}}}, tied to
the attachment that was read because a report can have several. NULL for a report read from a PDF with
text, or before this migration.

Revision ID: 0011_report_field_boxes
Revises: 0010_report_original_fields
Create Date: 2026-11-07 19:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0011_report_field_boxes'
down_revision: Union[str, None] = '0010_report_original_fields'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('reports', sa.Column('field_boxes', postgresql.JSONB(astext_type=sa.Text()), nullable=True))


def downgrade() -> None:
    op.drop_column('reports', 'field_boxes')
