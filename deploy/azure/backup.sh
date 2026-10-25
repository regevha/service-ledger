#!/usr/bin/env bash
# Takes a backup of a deployed environment into a dated folder on this machine:
#   database.dump   the whole database (pg_dump custom format; restore.sh reads it)
#   attachments/    every scanned file from the Azure Files share
#   MANIFEST.txt    when, which migration the database was at, row counts
#   SHA256SUMS      checksums, checked again before a restore
# The dump holds the reports, templates, instruments and extracted fields; the
# database stores only the PATHS of the scans, so keep the folder together.
#
# Usage:   ./deploy/azure/backup.sh <name> [folder]     e.g.  ./deploy/azure/backup.sh sl-test
#          folder defaults to backups/<name>-<UTC timestamp> (under the current directory)
# Needs:   Azure CLI logged in (az login), pg_dump 16 and psql on this machine, curl.
# Optional: NO_FILES=1  skip the scans (database only)
#           MY_IP=...   this machine's public address, if it cannot be looked up
# The database allows Azure services only, so the script opens it to this machine's address for the
# length of the run and closes it again. The folder holds real lab data and the dump is NOT
# encrypted: keep it somewhere private (backups/ is ignored by git).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$HERE/_common.sh"

STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
OUT="${2:-backups/$NAME-$STAMP}"
[[ ! -e "$OUT" ]] || { echo "$OUT already exists" >&2; exit 1; }
mkdir -p "$OUT"
chmod 700 "$OUT"

open_database
trap close_database EXIT

echo "== Database"
pg_dump --format=custom --no-owner --no-privileges --file="$OUT/database.dump"
pg_restore --list "$OUT/database.dump" >/dev/null   # proves the file can be read back
echo "   $(du -h "$OUT/database.dump" | cut -f1) written"

if [[ "${NO_FILES:-0}" != "1" ]]; then
  echo "== Scanned files (share $SHARE)"
  mkdir -p "$OUT/attachments"
  az storage file download-batch --source "$SHARE" --destination "$OUT/attachments" --no-progress -o none
  echo "   $(find "$OUT/attachments" -type f | wc -l) files"
fi

q() { psql -tA -c "$1"; }
{
  echo "environment:      $NAME"
  echo "taken (UTC):      $STAMP"
  echo "database:         $PGHOST / $PGDATABASE"
  echo "migration:        $(q 'select version_num from alembic_version')"
  echo "reports:          $(q 'select count(*) from reports')"
  echo "finalized:        $(q "select count(*) from reports where status = 'finalized'")"
  echo "instruments:      $(q 'select count(*) from instruments')"
  echo "templates:        $(q 'select count(*) from report_templates')"
  echo "attachments:      $(q 'select count(*) from attachments')"
  echo "scan files:       $( [[ -d "$OUT/attachments" ]] && find "$OUT/attachments" -type f | wc -l || echo 'not included')"
  echo "git commit:       $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
} > "$OUT/MANIFEST.txt"
(cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

echo
cat "$OUT/MANIFEST.txt"
echo
echo "Backup is in $OUT"
echo "Restore it with:  ./deploy/azure/restore.sh $NAME $OUT"
