"""add installation_upgrade to the report_type enum

Revision ID: e5f1b2c8d903
Revises: d4e8a1b7c902
Create Date: 2026-10-08 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'e5f1b2c8d903'
down_revision: Union[str, None] = 'd4e8a1b7c902'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ADD VALUE cannot run inside a transaction block on older Postgres, and
    # the new value cannot be used until it commits — hence the autocommit
    # block. The matching report_templates row is created by seed_templates
    # (app.main's startup lifespan runs it), not here.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'installation_upgrade'")


def downgrade() -> None:
    # Postgres cannot drop a single enum value, so rebuild the type without
    # it. Only possible while nothing uses the value: a template or report of
    # this type would have nowhere to go, so refuse rather than delete data.
    bind = op.get_bind()
    in_use = bind.exec_driver_sql(
        "SELECT count(*) FROM report_templates WHERE report_type = 'installation_upgrade'"
    ).scalar()
    if in_use:
        raise RuntimeError(
            f"Cannot downgrade: {in_use} report template(s) use report_type 'installation_upgrade'. "
            "Delete them (and any reports attached to them) first."
        )
    op.execute("ALTER TYPE report_type RENAME TO report_type_old")
    op.execute("CREATE TYPE report_type AS ENUM ('calibration', 'repair', 'preventive_maintenance')")
    op.execute(
        "ALTER TABLE report_templates ALTER COLUMN report_type TYPE report_type "
        "USING report_type::text::report_type"
    )
    op.execute("DROP TYPE report_type_old")
