"""drop instruments.institution and instruments.location: the place is the only copy

Step 4 of the places plan. Since step 1 every instrument with an institution (and
room) has pointed at a place, and the API reads the institution and room names
from it. This drops the two text columns.

It refuses to run while an instrument still has such text but no place (a room
with no institution, or a room name found in several faculties of its
institution): dropping the columns would lose that text. The error lists them;
fix them first (give the instrument an institution, or rename one of the rooms
on the Places screen), then run it again. Take a backup before upgrading a live
database. The downgrade adds the columns back and fills them from the places.

Revision ID: 0003_drop_place_text
Revises: 0002_places
Create Date: 2026-10-27 22:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0003_drop_place_text'
down_revision: Union[str, None] = '0002_places'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    stuck = op.get_bind().execute(sa.text(
        "SELECT name, serial_number, institution, location FROM instruments "
        "WHERE place_id IS NULL AND (btrim(coalesce(institution, '')) <> '' OR btrim(coalesce(location, '')) <> '') "
        "ORDER BY name"
    )).all()
    if stuck:
        lines = "\n".join(f"  {n} ({s}): institution={i!r} room={l!r}" for n, s, i, l in stuck)
        raise RuntimeError(
            "These instruments have an institution or room in text but no place, so dropping the text would lose it. "
            "Give each an institution, or rename duplicate rooms on the Places screen, then upgrade again:\n" + lines
        )
    op.drop_column('instruments', 'location')
    op.drop_column('instruments', 'institution')


def downgrade() -> None:
    op.add_column('instruments', sa.Column('institution', sa.String(), nullable=True))
    op.add_column('instruments', sa.Column('location', sa.String(), nullable=True))
    op.execute(sa.text("""
        UPDATE instruments i SET
          institution = CASE p.kind
            WHEN 'institution' THEN p.name
            WHEN 'faculty' THEN pp.name
            ELSE CASE pp.kind WHEN 'faculty' THEN ppp.name ELSE pp.name END
          END,
          location = CASE WHEN p.kind = 'room' THEN p.name END
        FROM places p
        LEFT JOIN places pp ON pp.id = p.parent_id
        LEFT JOIN places ppp ON ppp.id = pp.parent_id
        WHERE i.place_id = p.id
    """))
