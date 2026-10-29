"""filled_by_person: mark template fields a person fills in

Fields whose notes say "lab-manager-assigned" (fault category, retest result,
verification result) are not printed on the form. They get
`"filled_by_person": true` in the template's field list, so the review screen
always asks for them to be checked. Data only; no columns change. The
downgrade removes the key again.

Revision ID: 0005_filled_by_person
Revises: 0004_prompt_preview
Create Date: 2026-10-29 16:30:00.000000

"""
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0005_filled_by_person'
down_revision: Union[str, None] = '0004_prompt_preview'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MARKER = "lab-manager-assigned"


def _rewrite(change) -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, field_schema FROM report_templates")).fetchall()
    for row_id, schema in rows:
        if not isinstance(schema, dict) or not isinstance(schema.get("fields"), list):
            continue
        fields = [change(dict(f)) if isinstance(f, dict) else f for f in schema["fields"]]
        if fields == schema["fields"]:
            continue
        conn.execute(
            sa.text("UPDATE report_templates SET field_schema = CAST(:schema AS JSONB) WHERE id = :id"),
            {"schema": json.dumps({**schema, "fields": fields}), "id": row_id},
        )


def _mark(field: dict) -> dict:
    if str(field.get("notes") or "").lower().startswith(MARKER):
        field["filled_by_person"] = True
    return field


def _unmark(field: dict) -> dict:
    field.pop("filled_by_person", None)
    return field


def upgrade() -> None:
    _rewrite(_mark)


def downgrade() -> None:
    _rewrite(_unmark)
