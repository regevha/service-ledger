"""remove the calibration report type (and every calibration template and report)

Revision ID: a8b9c0d1e2f3
Revises: f7a8b9c0d1e2
Create Date: 2026-10-25 00:00:00.000000

Lab users asked for the type to go. This DELETES data: every calibration
report with its attachments, extraction jobs and translations, and every
calibration template. It cannot be undone by the downgrade, which only
restores the enum value. Scan files on disk are not touched.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'a8b9c0d1e2f3'
down_revision: Union[str, None] = 'f7a8b9c0d1e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_CAL_TEMPLATES = "(SELECT id FROM report_templates WHERE report_type = 'calibration')"
_CAL_REPORTS = f"(SELECT id FROM reports WHERE template_id IN {_CAL_TEMPLATES})"
_CAL_ATTACHMENTS = f"(SELECT id FROM attachments WHERE report_id IN {_CAL_REPORTS})"


def upgrade() -> None:
    op.execute(f"DELETE FROM extraction_jobs WHERE attachment_id IN {_CAL_ATTACHMENTS}")
    op.execute(f"DELETE FROM translations WHERE attachment_id IN {_CAL_ATTACHMENTS}")
    op.execute(f"DELETE FROM attachments WHERE report_id IN {_CAL_REPORTS}")
    op.execute(f"DELETE FROM reports WHERE template_id IN {_CAL_TEMPLATES}")
    op.execute("DELETE FROM report_templates WHERE report_type = 'calibration'")
    # A saved filter that pinned the removed type would match nothing and fail validation.
    op.execute("UPDATE saved_report_filters SET filters = filters - 'report_type' WHERE filters->>'report_type' = 'calibration'")

    op.execute("ALTER TYPE report_type RENAME TO report_type_old")
    op.execute("CREATE TYPE report_type AS ENUM ('repair', 'preventive_maintenance', 'installation_upgrade')")
    op.execute(
        "ALTER TABLE report_templates ALTER COLUMN report_type TYPE report_type "
        "USING report_type::text::report_type"
    )
    op.execute("DROP TYPE report_type_old")


def downgrade() -> None:
    # Deleted reports and templates do not come back; only the enum value does.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'calibration'")
