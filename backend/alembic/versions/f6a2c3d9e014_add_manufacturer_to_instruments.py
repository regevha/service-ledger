"""add manufacturer to instruments

Revision ID: f6a2c3d9e014
Revises: e5f1b2c8d903
Create Date: 2026-10-11 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f6a2c3d9e014'
down_revision: Union[str, None] = 'e5f1b2c8d903'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable free text: existing units simply have no manufacturer recorded.
    op.add_column('instruments', sa.Column('manufacturer', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('instruments', 'manufacturer')
