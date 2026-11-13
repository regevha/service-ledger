"""attachments.file_path becomes relative to the storage root

The column held the full path on disk, so a restore onto another mount (or another machine) left
every row pointing at a place that no longer existed. It now holds the path inside the storage
root ("<report id>/<uuid>.pdf"); the model joins the root back on at read time. Rows whose path is
under the storage root are converted; a row pointing anywhere else is left exactly as it is.

Run it with the same ATTACHMENT_STORAGE_DIR the app uses: that is how the root is found. Take a
backup first (deploy/azure/backup.sh). Downgrade turns the paths back into full paths under the
current root.

Revision ID: 0016_relative_attachment_paths
Revises: 0015_indexes
Create Date: 2026-11-13 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from app.services.storage_paths import storage_root, to_absolute, to_stored


revision: str = '0016_relative_attachment_paths'
down_revision: Union[str, None] = '0015_indexes'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _rewrite(convert) -> None:
    conn = op.get_bind()
    root = storage_root()
    rows = conn.execute(sa.text("SELECT id, file_path FROM attachments")).fetchall()
    for row_id, path in rows:
        new = convert(path, root)
        if new != path:
            conn.execute(sa.text("UPDATE attachments SET file_path = :p WHERE id = :i"), {"p": new, "i": row_id})


def upgrade() -> None:
    _rewrite(to_stored)


def downgrade() -> None:
    _rewrite(to_absolute)
