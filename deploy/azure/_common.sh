# Shared by backup.sh and restore.sh (sourced, not run). Works out the names deploy.sh used, reads the
# database password from the API app's secret, and opens the database to this machine's address for
# the length of the script (deploy.sh allows Azure services only), closing it again on exit.

NAME="${1:?usage: $(basename "$0") <name> ...   (the name you gave deploy.sh)}"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{2,13}$ ]] || { echo "name must be 3-14 chars: lowercase letters, digits, hyphens, starting with a letter" >&2; exit 1; }
for tool in az pg_dump pg_restore psql curl sha256sum; do
  command -v "$tool" >/dev/null || { echo "$tool is needed on this machine but was not found" >&2; exit 1; }
done

RG="rg-$NAME"
SUB_SHORT="$(az account show --query id -o tsv | tr -d '-' | cut -c1-6)"
BARE="${NAME//-/}"
STORAGE="${BARE}${SUB_SHORT}"; STORAGE="${STORAGE:0:24}"
PG="pg-${NAME}-${SUB_SHORT}"
SHARE="attachments"

# The full URL is stored as the API app's "database-url" secret; take the password out of it.
DB_URL="$(az containerapp secret show -g "$RG" -n "api-$NAME" --secret-name database-url --query value -o tsv)"
[[ -n "$DB_URL" ]] || { echo "could not read the database-url secret of api-$NAME in $RG" >&2; exit 1; }
export PGHOST="$PG.postgres.database.azure.com"
export PGUSER="slAdmin"
export PGDATABASE="service_ledger"
export PGSSLMODE="require"
PGPASSWORD="$(sed -E 's#^[^:]*://[^:]*:([^@]*)@.*#\1#' <<<"$DB_URL")"
export PGPASSWORD
AZURE_STORAGE_ACCOUNT="$STORAGE"
AZURE_STORAGE_KEY="$(az storage account keys list -g "$RG" -n "$STORAGE" --query '[0].value' -o tsv)"
export AZURE_STORAGE_ACCOUNT AZURE_STORAGE_KEY

# pg_dump/pg_restore must be at least as new as the server (16).
if [[ "$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')" -lt 16 ]]; then
  echo "pg_dump is older than the server (PostgreSQL 16). Install the postgresql-client-16 package." >&2; exit 1
fi

MY_IP="${MY_IP:-$(curl -fsS https://api.ipify.org)}"
FW_RULE="tmp-backup-$$"
open_database() {
  echo "== Opening the database to $MY_IP for this run"
  az postgres flexible-server firewall-rule create -g "$RG" -n "$PG" --rule-name "$FW_RULE" \
    --start-ip-address "$MY_IP" --end-ip-address "$MY_IP" -o none
  sleep 15   # the rule takes a moment to apply
}
close_database() {
  az postgres flexible-server firewall-rule delete -g "$RG" -n "$PG" --rule-name "$FW_RULE" --yes -o none 2>/dev/null || \
    echo "Could not remove the firewall rule $FW_RULE; delete it in the portal (server $PG, Networking)." >&2
}
