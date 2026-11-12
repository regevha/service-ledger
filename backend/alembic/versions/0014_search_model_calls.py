"""search_model_calls: the model-backed search cap counted in the database

The daily cap on model-backed searches was an in-memory counter: it started at
zero on every restart and each API replica kept its own, so a restart loop or a
second replica silently multiplied the limit. Each allowed call is now a row here
and the cap counts rows from the last 24 hours. Old rows are pruned as new ones
are written. Downgrade drops the table (the cap then starts empty).

Revision ID: 0014_search_model_calls
Revises: 0013_job_heartbeat
Create Date: 2026-11-12 19:50:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0014_search_model_calls'
down_revision: Union[str, None] = '0013_job_heartbeat'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'search_model_calls',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('called_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_search_model_calls_called_at'), 'search_model_calls', ['called_at'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_search_model_calls_called_at'), table_name='search_model_calls')
    op.drop_table('search_model_calls')
