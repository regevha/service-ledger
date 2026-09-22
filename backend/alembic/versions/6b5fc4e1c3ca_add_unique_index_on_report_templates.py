"""add unique index on report_templates (instrument_type, report_type, model)

Revision ID: 6b5fc4e1c3ca
Revises: c31a9f4d2b17
Create Date: 2026-09-22 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '6b5fc4e1c3ca'
down_revision: Union[str, None] = 'c31a9f4d2b17'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Until now this was only enforced procedurally, by seed_templates.py's
    # own existence-check before inserting a row — fine for a script that
    # runs alone, but the new POST/PATCH /report-templates endpoints
    # (routers/report_templates.py) can race two concurrent requests past
    # that same app-level check (TOCTOU), so this backs the rule with the
    # database itself, matching Instrument.serial_number's existing
    # unique=True (models.py).
    #
    # A plain UNIQUE constraint on the three columns wouldn't actually work
    # here: Postgres treats every NULL as distinct in a unique constraint,
    # so two `model IS NULL` rows for the same (instrument_type,
    # report_type) — the "applies to every model" fallback row
    # resolve_template() (services/templates.py) depends on being unique —
    # would both be allowed to exist, making that fallback lookup
    # ambiguous. COALESCE(model, '') collapses every NULL-model row for the
    # same (instrument_type, report_type) onto one indexed value instead —
    # safe because a template's model is always a real device model name,
    # never the empty string.
    op.execute(
        """
        CREATE UNIQUE INDEX uq_report_templates_type_model
        ON report_templates (instrument_type, report_type, COALESCE(model, ''))
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX uq_report_templates_type_model")
