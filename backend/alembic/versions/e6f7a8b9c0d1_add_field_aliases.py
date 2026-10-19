"""add field alias groups

Revision ID: e6f7a8b9c0d1
Revises: d4e5f6a7b8c9
Create Date: 2026-10-19 00:00:00.000000

"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'e6f7a8b9c0d1'
down_revision: Union[str, None] = 'd4e5f6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# The two groups the project owner confirmed on 2026-10-19, found by reading
# the eight seeded templates. Inserted once, here, rather than by a startup
# seed: a group that is deleted later must stay deleted.
_FIRST_GROUPS = [
    ("Result of the check after the work", ["retest_result", "verification_result"]),
    ("Parts replaced or used", ["components_replaced", "parts_used"]),
]


def upgrade() -> None:
    groups = op.create_table(
        'field_alias_groups',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('label', sa.String(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    names = op.create_table(
        'field_alias_names',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            'group_id',
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey('field_alias_groups.id', ondelete='CASCADE'),
            nullable=False,
        ),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('normalized', sa.String(), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False, server_default='0'),
        sa.UniqueConstraint('normalized', name='field_alias_names_normalized_key'),
    )
    op.create_index('ix_field_alias_names_group_id', 'field_alias_names', ['group_id'])

    for label, members in _FIRST_GROUPS:
        group_id = uuid.uuid4()
        op.bulk_insert(groups, [{'id': group_id, 'label': label}])
        op.bulk_insert(
            names,
            [
                {
                    'id': uuid.uuid4(),
                    'group_id': group_id,
                    'name': member,
                    'normalized': member.replace('_', '').lower(),
                    'position': position,
                }
                for position, member in enumerate(members)
            ],
        )


def downgrade() -> None:
    op.drop_index('ix_field_alias_names_group_id', table_name='field_alias_names')
    op.drop_table('field_alias_names')
    op.drop_table('field_alias_groups')
