"""Keep extraction confidence and explicit review checks with each report."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0017_report_review_state"
down_revision = "0016_relative_attachment_paths"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("reports", sa.Column("review_state", postgresql.JSONB(), nullable=True))


def downgrade():
    op.drop_column("reports", "review_state")
