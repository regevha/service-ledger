"""add institution to instruments

Revision ID: f7a8b9c0d1e2
Revises: e6f7a8b9c0d1
Create Date: 2026-10-25 21:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f7a8b9c0d1e2'
down_revision: Union[str, None] = 'e6f7a8b9c0d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable free text: existing units simply have no institution recorded.
    op.add_column('instruments', sa.Column('institution', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('instruments', 'institution')
