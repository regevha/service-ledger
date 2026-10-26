"""add instrument_models and link instruments to them

Revision ID: b1c2d3e4f5a6
Revises: a8b9c0d1e2f3
Create Date: 2026-10-26 20:00:00.000000

Step 1 of the models plan: a record per distinct model text, and every
instrument linked to the record whose name equals its model text exactly.
Nothing is merged: "FACSAria III" and "FACS Aria III" become two records until
a person decides otherwise. Manufacturer and instrument type of a record come
from its instruments (the most common non-empty value; ties go to the first
alphabetically). Instruments keep their own copies and nothing reads the new
table yet. The downgrade drops the link and the table, and loses nothing else.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'b1c2d3e4f5a6'
down_revision: Union[str, None] = 'a8b9c0d1e2f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'instrument_models',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('manufacturer', sa.String(), nullable=True),
        sa.Column('instrument_type', sa.String(), nullable=False),
        sa.Column('service_interval_months', sa.Integer(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'),
    )
    op.add_column('instruments', sa.Column('model_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.create_index(op.f('ix_instruments_model_id'), 'instruments', ['model_id'], unique=False)
    op.create_foreign_key('fk_instruments_model_id', 'instruments', 'instrument_models', ['model_id'], ['id'])

    op.execute(
        """
        INSERT INTO instrument_models (id, name, manufacturer, instrument_type)
        SELECT gen_random_uuid(),
               g.model,
               (SELECT m.manufacturer FROM instruments m
                 WHERE m.model = g.model AND m.manufacturer IS NOT NULL
                 GROUP BY m.manufacturer ORDER BY count(*) DESC, m.manufacturer LIMIT 1),
               (SELECT t.instrument_type FROM instruments t
                 WHERE t.model = g.model
                 GROUP BY t.instrument_type ORDER BY count(*) DESC, t.instrument_type LIMIT 1)
          FROM (SELECT DISTINCT model FROM instruments) g
        """
    )
    op.execute("UPDATE instruments i SET model_id = m.id FROM instrument_models m WHERE m.name = i.model")


def downgrade() -> None:
    op.drop_constraint('fk_instruments_model_id', 'instruments', type_='foreignkey')
    op.drop_index(op.f('ix_instruments_model_id'), table_name='instruments')
    op.drop_column('instruments', 'model_id')
    op.drop_table('instrument_models')
