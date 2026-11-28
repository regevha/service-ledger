"""Add pending reply threading metadata and notification preferences."""

import sqlalchemy as sa
from alembic import op

revision = "0018_intake_receipts"
down_revision = "0017_email_intake"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("intake_messages", sa.Column("reply_subject", sa.String(240), nullable=True))
    op.add_column("intake_messages", sa.Column("reply_to_message_id", sa.String(254), nullable=True))
    op.add_column("intake_files", sa.Column("receipt_type_hint", sa.String(40), nullable=True))
    op.create_table("intake_notification_opt_outs", sa.Column("address", sa.String(254), primary_key=True))


def downgrade() -> None:
    op.drop_table("intake_notification_opt_outs")
    op.drop_column("intake_files", "receipt_type_hint")
    op.drop_column("intake_messages", "reply_to_message_id")
    op.drop_column("intake_messages", "reply_subject")
