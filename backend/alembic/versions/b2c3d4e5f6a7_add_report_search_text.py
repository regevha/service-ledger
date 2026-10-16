"""add reports.search_text and its full-text index

Revision ID: b2c3d4e5f6a7
Revises: f6a2c3d9e014
Create Date: 2026-10-15 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b2c3d4e5f6a7'
down_revision: Union[str, None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _search_text(field_schema, extracted_fields, model, serial):
    """The searchable text of one report: instrument model and serial, then the
    template's text fields and the text columns of its tables. A frozen copy of
    app.services.report_search.build_search_text, so this migration does not
    change meaning if that module later does."""
    parts = [p for p in (model, serial) if p]
    fields = extracted_fields or {}
    if isinstance(field_schema, dict):
        field_schema = field_schema.get("fields")
    for field in field_schema or []:
        value = fields.get(field.get("name"))
        kind = field.get("type")
        if kind == "text" and isinstance(value, str) and value.strip():
            parts.append(value.strip())
        elif kind == "object[]" and isinstance(value, list):
            columns = [c["name"] for c in field.get("item_schema") or [] if c.get("type") == "text"]
            for row in value:
                if isinstance(row, dict):
                    for column in columns:
                        cell = row.get(column)
                        if isinstance(cell, str) and cell.strip():
                            parts.append(cell.strip())
    return "\n".join(parts) or None


def upgrade() -> None:
    op.add_column('reports', sa.Column('search_text', sa.Text(), nullable=True))

    # Backfill every existing report.
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT r.id, r.extracted_fields, t.field_schema, i.model, i.serial_number "
            "FROM reports r "
            "LEFT JOIN report_templates t ON t.id = r.template_id "
            "LEFT JOIN instruments i ON i.id = r.instrument_id"
        )
    ).fetchall()
    for report_id, fields, schema, model, serial in rows:
        value = _search_text(schema, fields, model, serial)
        if value:
            bind.execute(
                sa.text("UPDATE reports SET search_text = :v WHERE id = :id"), {"v": value, "id": report_id}
            )

    # Finalized reports only: free-text search never returns anything else.
    # The expression must match services/report_search.TSVECTOR_SQL.
    op.execute(
        "CREATE INDEX ix_reports_search_tsv ON reports "
        "USING gin (to_tsvector('simple', coalesce(search_text, ''))) "
        "WHERE status = 'finalized'"
    )


def downgrade() -> None:
    op.execute("DROP INDEX ix_reports_search_tsv")
    op.drop_column('reports', 'search_text')
