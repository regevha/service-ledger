"""add content_sha256 and work_order_number to attachments

Revision ID: d4e8a1b7c902
Revises: 6b5fc4e1c3ca
Create Date: 2026-10-07 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd4e8a1b7c902'
down_revision: Union[str, None] = '6b5fc4e1c3ca'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Both nullable with no backfill: attachments uploaded before this
    # migration simply can't be matched as duplicates (no hash / no work order
    # read yet); every new upload and classification fills them in.
    op.add_column('attachments', sa.Column('content_sha256', sa.String(length=64), nullable=True))
    op.add_column('attachments', sa.Column('work_order_number', sa.String(), nullable=True))
    op.create_index(op.f('ix_attachments_content_sha256'), 'attachments', ['content_sha256'])
    op.create_index(op.f('ix_attachments_work_order_number'), 'attachments', ['work_order_number'])


def downgrade() -> None:
    op.drop_index(op.f('ix_attachments_work_order_number'), table_name='attachments')
    op.drop_index(op.f('ix_attachments_content_sha256'), table_name='attachments')
    op.drop_column('attachments', 'work_order_number')
    op.drop_column('attachments', 'content_sha256')
