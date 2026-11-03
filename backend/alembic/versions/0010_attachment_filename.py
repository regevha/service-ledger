"""attachments get an original_filename column

Until now the uploader's file name existed only inside the stored path
("<report id>/<uuid>_<original name>"), which put client-chosen text (Hebrew
names, names with characters an SMB share refuses, names near the 255 byte
limit) on the storage's file names and into every log line that prints a path.
New uploads are stored under a generated name and keep the original name in this
column; this migration adds the column and fills it for existing rows from their
paths. Existing files are not renamed or moved: each row keeps its own file_path,
so old and new files work side by side. Nothing is deleted or rewritten except
the new column, and downgrade drops it again (the old paths still hold the names).

Revision ID: 0010_attachment_filename
Revises: 0009_flow_cytometer_type_key
Create Date: 2026-11-03 21:00:00.000000

"""
import re
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0010_attachment_filename'
down_revision: Union[str, None] = '0009_flow_cytometer_type_key'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_UUID_PREFIX = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}_")


def _original_name(file_path: str) -> str:
    name = file_path.replace("\\", "/").rsplit("/", 1)[-1]
    return _UUID_PREFIX.sub("", name, count=1)


def upgrade() -> None:
    op.add_column('attachments', sa.Column('original_filename', sa.String(), nullable=True))
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, file_path FROM attachments")).fetchall()
    for row in rows:
        name = _original_name(row.file_path)
        if name:
            conn.execute(
                sa.text("UPDATE attachments SET original_filename = :n WHERE id = :i"),
                {"n": name, "i": row.id},
            )


def downgrade() -> None:
    op.drop_column('attachments', 'original_filename')
