"""manufacturers: makers as records, and manufacturer_id on instruments and models

Fills the table from the instruments' and models' manufacturer text and links every
row. Spellings that differ only in case, spaces or punctuation become one maker, and
so do the known alternative names of BD, Cytek and Beckman Coulter listed below;
nothing else is merged by guess. The text column of each row is rewritten to the
maker's canonical name (the most common spelling, or the known name). The downgrade
drops the links and the table; the text columns stay as they are.

Revision ID: 0008_manufacturers
Revises: 0007_fault_category_list
Create Date: 2026-10-30 22:30:00.000000

"""
import json
import re
import uuid
from collections import Counter
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0008_manufacturers'
down_revision: Union[str, None] = '0007_fault_category_list'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# The same list as services/manufacturers.py DEFAULT_MAKERS, copied so this
# migration keeps working if that list changes later.
_KNOWN = [
    ("BD", ["Becton Dickinson", "Becton, Dickinson and Company", "BD Biosciences", "BD Life Sciences"]),
    ("Cytek Biosciences", ["Cytek"]),
    ("Beckman Coulter", ["Beckman", "Beckman Coulter Life Sciences"]),
]


def _key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def upgrade() -> None:
    op.create_table(
        'manufacturers',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('aliases', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('uq_manufacturers_name_lower', 'manufacturers', [sa.literal_column('lower(name)')], unique=True)
    for table in ('instruments', 'instrument_models'):
        op.add_column(table, sa.Column('manufacturer_id', sa.UUID(), nullable=True))
        op.create_index(op.f(f'ix_{table}_manufacturer_id'), table, ['manufacturer_id'], unique=False)
        op.create_foreign_key(f'fk_{table}_manufacturer_id', table, 'manufacturers', ['manufacturer_id'], ['id'])
    _fill_manufacturers()


def downgrade() -> None:
    for table in ('instrument_models', 'instruments'):
        op.drop_constraint(f'fk_{table}_manufacturer_id', table, type_='foreignkey')
        op.drop_index(op.f(f'ix_{table}_manufacturer_id'), table_name=table)
        op.drop_column(table, 'manufacturer_id')
    op.drop_index('uq_manufacturers_name_lower', table_name='manufacturers')
    op.drop_table('manufacturers')


def _fill_manufacturers() -> None:
    conn = op.get_bind()
    spellings: Counter = Counter()
    for table in ('instruments', 'instrument_models'):
        for (text,) in conn.execute(sa.text(f"SELECT manufacturer FROM {table} WHERE manufacturer IS NOT NULL")):
            if _clean(text) and _key(text):
                spellings[_clean(text)] += 1
    if not spellings:
        return

    known_by_key: dict[str, tuple[str, list[str]]] = {}
    for name, aliases in _KNOWN:
        for text in (name, *aliases):
            known_by_key[_key(text)] = (name, aliases)

    # group key -> (canonical name, aliases to store, member spellings)
    groups: dict[str, dict] = {}
    for spelling, _count in spellings.most_common():
        key = _key(spelling)
        known = known_by_key.get(key)
        gkey = _key(known[0]) if known else key
        group = groups.setdefault(gkey, {"known": known, "spellings": []})
        group["spellings"].append(spelling)

    names: dict[str, tuple[uuid.UUID, str]] = {}  # spelling key -> (maker id, canonical name)
    for gkey, group in groups.items():
        known = group["known"]
        if known:
            name, aliases = known[0], list(known[1])
        else:
            name, aliases = group["spellings"][0], []  # most common spelling first
        maker_id = uuid.uuid4()
        conn.execute(
            sa.text("INSERT INTO manufacturers (id, name, aliases) VALUES (:id, :name, CAST(:aliases AS JSONB))"),
            {"id": maker_id, "name": name, "aliases": json.dumps(aliases)},
        )
        for spelling in group["spellings"]:
            names[_key(spelling)] = (maker_id, name)

    for table in ('instruments', 'instrument_models'):
        rows = conn.execute(sa.text(f"SELECT id, manufacturer FROM {table} WHERE manufacturer IS NOT NULL")).fetchall()
        for row_id, text in rows:
            hit = names.get(_key(text)) if _clean(text) else None
            if hit is None:
                continue
            conn.execute(
                sa.text(f"UPDATE {table} SET manufacturer_id = :m, manufacturer = :n WHERE id = :id"),
                {"m": hit[0], "n": hit[1], "id": row_id},
            )
