"""fault category becomes a list of choices; mark root cause optional

Data only; no columns change.
  - Templates: the field `fault_category` changes type from `enum` to `enum[]`
    (any number of the listed choices). The `root_cause` field gets
    `"optional": true`, so an empty one is not flagged on the review screen.
  - Reports and jobs: a stored `fault_category` string becomes a one-item list
    (an empty string becomes an empty list).
The downgrade turns a list back into its first item.

Revision ID: 0007_fault_category_list
Revises: 0006_template_cleanup
Create Date: 2026-10-30 12:00:00.000000

"""
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0007_fault_category_list'
down_revision: Union[str, None] = '0006_template_cleanup'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _update_json(table: str, column: str, change) -> None:
    conn = op.get_bind()
    for row_id, value in conn.execute(sa.text(f"SELECT id, {column} FROM {table}")).fetchall():
        changed = change(value)
        if changed != value:
            conn.execute(
                sa.text(f"UPDATE {table} SET {column} = CAST(:v AS JSONB) WHERE id = :id"),
                {"v": json.dumps(changed), "id": row_id},
            )


def _schema_up(schema):
    if not isinstance(schema, dict) or not isinstance(schema.get("fields"), list):
        return schema
    fields = []
    for f in schema["fields"]:
        if isinstance(f, dict) and f.get("name") == "fault_category" and f.get("type") == "enum":
            f = {**f, "type": "enum[]"}
        if isinstance(f, dict) and f.get("name") == "root_cause":
            f = {**f, "optional": True}
        fields.append(f)
    return {**schema, "fields": fields}


def _schema_down(schema):
    if not isinstance(schema, dict) or not isinstance(schema.get("fields"), list):
        return schema
    fields = []
    for f in schema["fields"]:
        if isinstance(f, dict) and f.get("name") == "fault_category" and f.get("type") == "enum[]":
            f = {**f, "type": "enum"}
        if isinstance(f, dict):
            f = {k: v for k, v in f.items() if k != "optional"}
        fields.append(f)
    return {**schema, "fields": fields}


def _values_up(values):
    if isinstance(values, dict) and isinstance(values.get("fault_category"), str):
        text = values["fault_category"].strip()
        return {**values, "fault_category": [text] if text else []}
    return values


def _values_down(values):
    if isinstance(values, dict) and isinstance(values.get("fault_category"), list):
        first = next((v for v in values["fault_category"] if isinstance(v, str) and v), "")
        return {**values, "fault_category": first}
    return values


def upgrade() -> None:
    _update_json("report_templates", "field_schema", _schema_up)
    _update_json("reports", "extracted_fields", _values_up)


def downgrade() -> None:
    _update_json("report_templates", "field_schema", _schema_down)
    _update_json("reports", "extracted_fields", _values_down)
