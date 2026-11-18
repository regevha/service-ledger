"""Index extracted, in-review and finalized reports for text search.

Revision ID: 0017_pending_search
Revises: 0016_relative_attachment_paths
"""
from alembic import op
import sqlalchemy as sa


revision = "0017_pending_search"
down_revision = "0016_relative_attachment_paths"
branch_labels = None
depends_on = None


def _replace_index(predicate: str) -> None:
    op.drop_index("ix_reports_search_tsv", table_name="reports")
    op.create_index(
        "ix_reports_search_tsv",
        "reports",
        [sa.literal_column("to_tsvector('simple', coalesce(search_text, ''))")],
        postgresql_using="gin",
        postgresql_where=sa.text(predicate),
    )


def upgrade() -> None:
    _replace_index("status IN ('extracted', 'in_review', 'finalized')")


def downgrade() -> None:
    _replace_index("status = 'finalized'")
