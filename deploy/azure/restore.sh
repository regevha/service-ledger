#!/usr/bin/env bash
# Puts a backup made by backup.sh back into a deployed environment: REPLACES the
# whole database with the dump and (unless told otherwise) copies the scanned
# files back to the Azure Files share. Anything saved since the backup is lost,
# so the script first takes a safety backup of what is there now.
#
# Usage:   ./deploy/azure/restore.sh <name> <backup folder>
#            e.g.  ./deploy/azure/restore.sh sl-test backups/sl-test-20261025-203000Z
# Needs:   Azure CLI logged in (az login), pg_restore 16 and psql, curl.
# Optional: NO_FILES=1            restore the database only
#           SKIP_SAFETY_BACKUP=1  do not back up the current state first (not recommended)
#           MY_IP=...             this machine's public address, if it cannot be looked up
# The API and the worker are stopped while it runs and started again at the end. The restore runs as
# one transaction: if it fails, the database is left as it was. A dump older than the deployed code
# comes back with the old schema; run ./deploy/azure/update.sh <name> afterwards to migrate it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IN="${2:?usage: restore.sh <name> <backup folder>}"
[[ -f "$IN/database.dump" ]] || { echo "$IN/database.dump not found" >&2; exit 1; }
# shellcheck source=_common.sh
source "$HERE/_common.sh"

echo "== Checking the backup is intact"
(cd "$IN" && sha256sum --check --quiet SHA256SUMS) || { echo "the backup does not match its checksums; not restoring" >&2; exit 1; }
pg_restore --list "$IN/database.dump" >/dev/null
echo
cat "$IN/MANIFEST.txt" 2>/dev/null || true
echo
echo "This REPLACES the database of $NAME ($PGHOST) with the backup above."
read -r -p "Type the name to confirm: " ans
[[ "$ans" == "$NAME" ]] || { echo "not confirmed"; exit 1; }

if [[ "${SKIP_SAFETY_BACKUP:-0}" != "1" ]]; then
  SAFETY="backups/$NAME-before-restore-$(date -u +%Y%m%d-%H%M%SZ)"
  echo "== Safety backup of the current state -> $SAFETY"
  "$HERE/backup.sh" "$NAME" "$SAFETY" >/dev/null
fi

open_database
APPS_STOPPED=0
start_apps() {
  if [[ "$APPS_STOPPED" == "1" ]]; then
    echo "== Starting the API and the worker"
    for app in "api-$NAME" "worker-$NAME"; do
      az containerapp update -g "$RG" -n "$app" --min-replicas 1 --max-replicas 1 -o none
    done
  fi
}
cleanup() { start_apps; close_database; }
trap cleanup EXIT

echo "== Stopping the API and the worker"
APPS_STOPPED=1
for app in "api-$NAME" "worker-$NAME"; do
  az containerapp update -g "$RG" -n "$app" --min-replicas 0 --max-replicas 0 -o none
done

echo "== Restoring the database (one transaction)"
pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error \
  --dbname="$PGDATABASE" "$IN/database.dump"

if [[ "${NO_FILES:-0}" != "1" && -d "$IN/attachments" ]]; then
  echo "== Copying the scanned files back to the share"
  az storage file upload-batch --source "$IN/attachments" --destination "$SHARE" --no-progress -o none
fi

q() { psql -tA -c "$1"; }
echo "== Now in the database: $(q 'select count(*) from reports') reports, migration $(q 'select version_num from alembic_version')"
echo "Done. If the backup is older than the deployed code, run ./deploy/azure/update.sh $NAME to bring the schema up to date."
