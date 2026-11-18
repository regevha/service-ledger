"""Persist classification decisions independently of job retention."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0017_classification_history"
down_revision = "0016_relative_attachment_paths"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("reports", sa.Column("classification_history", postgresql.JSONB(), nullable=True))


def downgrade():
    op.drop_column("reports", "classification_history")
