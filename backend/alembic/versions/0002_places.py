"""places: institutions, faculties and rooms as records, and instruments.place_id

Step 1 of the places plan. Fills the table from the instruments' institution and
room text (spaces collapsed, equal ignoring case) and links every instrument to
the most specific place its text names: a room, else the institution. A room with
no institution has nowhere to sit and stays unlinked. Nothing is merged by guess:
spellings that differ stay separate places; `python -m app.tools.list_places`
lists the ones that look alike. The text columns stay and stay the source.

Revision ID: 0002_places
Revises: 0001_baseline
Create Date: 2026-10-27 13:20:42.139979

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0002_places'
down_revision: Union[str, None] = '0001_baseline'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('places',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('kind', sa.String(), nullable=False),
    sa.Column('name', sa.String(), nullable=False),
    sa.Column('parent_id', sa.UUID(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['parent_id'], ['places.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_places_parent_id', 'places', ['parent_id'], unique=False)
    op.create_index('uq_places_kind_parent_name', 'places', ['kind', sa.literal_column("coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)"), sa.literal_column('lower(name)')], unique=True)
    op.add_column('instruments', sa.Column('place_id', sa.UUID(), nullable=True))
    op.create_index(op.f('ix_instruments_place_id'), 'instruments', ['place_id'], unique=False)
    op.create_foreign_key('fk_instruments_place_id', 'instruments', 'places', ['place_id'], ['id'])
    _fill_places()


def downgrade() -> None:
    op.drop_constraint('fk_instruments_place_id', 'instruments', type_='foreignkey')
    op.drop_index(op.f('ix_instruments_place_id'), table_name='instruments')
    op.drop_column('instruments', 'place_id')
    op.drop_index('uq_places_kind_parent_name', table_name='places')
    op.drop_index('ix_places_parent_id', table_name='places')
    op.drop_table('places')


_INST = "regexp_replace(btrim(i.institution), '\\s+', ' ', 'g')"
_ROOM = "regexp_replace(btrim(i.location), '\\s+', ' ', 'g')"
_HAS_INST = "btrim(coalesce(i.institution, '')) <> ''"
_HAS_ROOM = "btrim(coalesce(i.location, '')) <> ''"


def _fill_places() -> None:
    op.execute(
        f"""
        INSERT INTO places (id, kind, name)
        SELECT gen_random_uuid(), 'institution', n FROM (
            SELECT DISTINCT ON (lower(n)) n FROM (
                SELECT {_INST} AS n, i.created_at FROM instruments i WHERE {_HAS_INST}
            ) s ORDER BY lower(n), created_at
        ) t
        """
    )
    op.execute(
        f"""
        INSERT INTO places (id, kind, name, parent_id)
        SELECT gen_random_uuid(), 'room', r, pid FROM (
            SELECT DISTINCT ON (pid, lower(r)) r, pid FROM (
                SELECT {_ROOM} AS r, p.id AS pid, i.created_at
                FROM instruments i
                JOIN places p ON p.kind = 'institution' AND lower(p.name) = lower({_INST})
                WHERE {_HAS_INST} AND {_HAS_ROOM}
            ) s ORDER BY pid, lower(r), created_at
        ) t
        """
    )
    op.execute(
        f"""
        UPDATE instruments i SET place_id = r.id
        FROM places r JOIN places p ON r.parent_id = p.id AND p.kind = 'institution'
        WHERE r.kind = 'room' AND {_HAS_INST} AND {_HAS_ROOM}
          AND lower(p.name) = lower({_INST}) AND lower(r.name) = lower({_ROOM})
        """
    )
    op.execute(
        f"""
        UPDATE instruments i SET place_id = p.id
        FROM places p
        WHERE p.kind = 'institution' AND i.place_id IS NULL AND {_HAS_INST} AND NOT ({_HAS_ROOM})
          AND lower(p.name) = lower({_INST})
        """
    )
