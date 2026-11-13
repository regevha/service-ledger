"""glossary_terms: technical terms for the Hebrew translation

A translation turned "כיוון / כיוונון לייזר" (laser alignment) into "laser direction", which reads as
nonsense to an engineer. The glossary holds the right English term for such words; the translation prompt
is given the list, and a known wrong rendering left in a translation is corrected after the call. Seeded
with that first case. Downgrade drops the table.

Revision ID: 0017_glossary_terms
Revises: 0016_relative_attachment_paths
Create Date: 2026-11-13 15:00:00.000000

"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0017_glossary_terms'
down_revision: Union[str, None] = '0016_relative_attachment_paths'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


SEED = [
    ("כיוון לייזר", "laser direction", "laser alignment", "Adjusting the laser's beam path; not a direction."),
    ("כיוונון לייזר", None, "laser alignment", None),
]


def upgrade() -> None:
    table = op.create_table(
        'glossary_terms',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('source_term', sa.String(), nullable=True),
        sa.Column('wrong_term', sa.String(), nullable=True),
        sa.Column('english_term', sa.String(), nullable=False),
        sa.Column('note', sa.String(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.bulk_insert(
        table,
        [
            {"id": uuid.uuid4(), "source_term": s, "wrong_term": w, "english_term": e, "note": n}
            for s, w, e, n in SEED
        ],
    )


def downgrade() -> None:
    op.drop_table('glossary_terms')
