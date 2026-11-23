"""Store the shared translation review setting."""

import sqlalchemy as sa
from alembic import op

revision = "0017_report_intake_settings"
down_revision = "0016_relative_attachment_paths"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "report_intake_settings",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("show_translation_review", sa.Boolean(), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_report_intake_settings_singleton"),
    )


def downgrade() -> None:
    op.drop_table("report_intake_settings")
