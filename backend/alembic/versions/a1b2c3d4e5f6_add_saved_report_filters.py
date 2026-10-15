"""add saved_report_filters

Revision ID: a1b2c3d4e5f6
Revises: f6a2c3d9e014
Create Date: 2026-10-15 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = 'a7c4e1f2b836'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'saved_report_filters',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('filters', postgresql.JSONB(), nullable=False),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    # Names are unique across everyone, ignoring case and surrounding spaces.
    op.create_index(
        'uq_saved_report_filters_name',
        'saved_report_filters',
        [sa.text('lower(btrim(name))')],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index('uq_saved_report_filters_name', table_name='saved_report_filters')
    op.drop_table('saved_report_filters')
