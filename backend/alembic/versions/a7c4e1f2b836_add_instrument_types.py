"""add instrument_types table

Revision ID: a7c4e1f2b836
Revises: f6a2c3d9e014
Create Date: 2026-10-13 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'a7c4e1f2b836'
down_revision: Union[str, None] = 'f6a2c3d9e014'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    table = op.create_table(
        'instrument_types',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('key', sa.String(), nullable=False, unique=True),
        sa.Column('display_name', sa.String(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    # Every existing instrument and template is "facs"; it becomes the first type.
    op.execute(
        "INSERT INTO instrument_types (id, key, display_name) "
        "VALUES (gen_random_uuid(), 'facs', 'Flow cytometer')"
    )
    # Any other value already stored (should not exist) gets a row too, so
    # nothing ends up pointing at a type that is not in the list.
    op.execute(
        "INSERT INTO instrument_types (id, key, display_name) "
        "SELECT gen_random_uuid(), t, t FROM ("
        " SELECT instrument_type AS t FROM instruments"
        " UNION SELECT instrument_type FROM report_templates"
        ") s WHERE t NOT IN (SELECT key FROM instrument_types)"
    )


def downgrade() -> None:
    op.drop_table('instrument_types')
