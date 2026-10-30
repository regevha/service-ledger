"""template cleanup: drop retest/verification, signature, contract and calibrated-tools fields

Decided 2026-10-29 (see the review doc). Data only; no columns change.

For every row in `report_templates`:
  - removes these fields from the field list: retest_result, verification_result,
    calibrated_tools, customer_order_number, customer_signature_present,
    service_contract_level, service_contract_number;
  - renames the installation field `parts_used` to `components_replaced`, so
    parts add up with repair and maintenance in Analytics.

For every report (`reports.extracted_fields`) and extraction job
(`extraction_jobs.field_confidences`): deletes the values of those dropped
fields and renames `parts_used` the same way (unless `components_replaced`
is already there).

Deletes the field-alias group that holds retest_result / verification_result.

THE DELETION OF STORED VALUES CANNOT BE UNDONE. There is no real data yet, so no
backup was taken. The downgrade is a deliberate no-op: the removed values are
gone, and the old templates come back only by reseeding an older version.

Revision ID: 0006_template_cleanup
Revises: 0005_filled_by_person
Create Date: 2026-10-30 10:00:00.000000

"""
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0006_template_cleanup'
down_revision: Union[str, None] = '0005_filled_by_person'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DROPPED = (
    "retest_result",
    "verification_result",
    "calibrated_tools",
    "customer_order_number",
    "customer_signature_present",
    "service_contract_level",
    "service_contract_number",
)
RENAMED = ("parts_used", "components_replaced")
ALIAS_NORMALIZED = ("retestresult", "verificationresult")


def _clean_map(values):
    """The same dict without the dropped keys and with parts_used renamed."""
    if not isinstance(values, dict):
        return values
    cleaned = {k: v for k, v in values.items() if k not in DROPPED}
    old, new = RENAMED
    if old in cleaned:
        value = cleaned.pop(old)
        cleaned.setdefault(new, value)
    return cleaned


def _clean_fields(fields):
    out = []
    for field in fields:
        if not isinstance(field, dict):
            out.append(field)
            continue
        if field.get("name") in DROPPED:
            continue
        if field.get("name") == RENAMED[0]:
            field = {**field, "name": RENAMED[1]}
        out.append(field)
    return out


def _update_json(table: str, column: str, clean) -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text(f"SELECT id, {column} FROM {table}")).fetchall()
    for row_id, value in rows:
        cleaned = clean(value)
        if cleaned == value:
            continue
        conn.execute(
            sa.text(f"UPDATE {table} SET {column} = CAST(:v AS JSONB) WHERE id = :id"),
            {"v": json.dumps(cleaned), "id": row_id},
        )


def _clean_schema(schema):
    if not isinstance(schema, dict) or not isinstance(schema.get("fields"), list):
        return schema
    return {**schema, "fields": _clean_fields(schema["fields"])}


def upgrade() -> None:
    _update_json("report_templates", "field_schema", _clean_schema)
    _update_json("reports", "extracted_fields", _clean_map)
    _update_json("extraction_jobs", "field_confidences", _clean_map)
    op.get_bind().execute(
        sa.text(
            "DELETE FROM field_alias_groups WHERE id IN "
            "(SELECT group_id FROM field_alias_names WHERE normalized IN :names)"
        ).bindparams(sa.bindparam("names", expanding=True)),
        {"names": list(ALIAS_NORMALIZED)},
    )


def downgrade() -> None:
    # Deleted values cannot be restored. See the module docstring.
    pass
