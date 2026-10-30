"""the instrument type key "facs" becomes "flow_cytometer"

"facs" is a BD product name; the type is every flow cytometer, whoever makes it. The
display name ("Flow cytometer") does not change. The key is stored in four places, all
rewritten here: instruments, instrument_models, report_templates and instrument_types.
Nothing else stores it (saved filters and browser storage hold no type).

If someone already added a type called "Flow cytometer" by hand (its key would be
"flow_cytometer"), it is folded in when nothing uses it; if something does use it, the
migration stops with a message instead of guessing how to merge two types.

Revision ID: 0009_flow_cytometer_type_key
Revises: 0008_manufacturers
Create Date: 2026-10-30 23:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0009_flow_cytometer_type_key'
down_revision: Union[str, None] = '0008_manufacturers'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_USERS = ('instruments', 'instrument_models', 'report_templates')


def _rename(old: str, new: str) -> None:
    conn = op.get_bind()
    has_old = conn.execute(sa.text("SELECT 1 FROM instrument_types WHERE key = :k"), {"k": old}).first()
    if not has_old:
        return
    if conn.execute(sa.text("SELECT 1 FROM instrument_types WHERE key = :k"), {"k": new}).first():
        used = sum(
            conn.execute(sa.text(f"SELECT count(*) FROM {t} WHERE instrument_type = :k"), {"k": new}).scalar() or 0
            for t in _USERS
        )
        if used:
            raise RuntimeError(
                f"The instrument type key '{new}' already exists and is in use, so '{old}' cannot be renamed to it. "
                f"Move those rows to '{old}' (or merge the two types by hand) and run the migration again."
            )
        conn.execute(sa.text("DELETE FROM instrument_types WHERE key = :k"), {"k": new})
    for table in (*_USERS, 'instrument_types'):
        conn.execute(sa.text(f"UPDATE {table} SET {'key' if table == 'instrument_types' else 'instrument_type'} = :new WHERE {'key' if table == 'instrument_types' else 'instrument_type'} = :old"), {"new": new, "old": old})


def upgrade() -> None:
    _rename('facs', 'flow_cytometer')


def downgrade() -> None:
    _rename('flow_cytometer', 'facs')
