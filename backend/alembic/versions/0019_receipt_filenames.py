"""Keep attachment names while their email receipt is pending."""

import sqlalchemy as sa
from alembic import op

revision = "0019_receipt_filenames"
down_revision = "0018_intake_receipts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("intake_files", sa.Column("receipt_filename", sa.String(160), nullable=True))


def downgrade() -> None:
    op.drop_column("intake_files", "receipt_filename")
