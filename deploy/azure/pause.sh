#!/usr/bin/env bash
# Stops paying for the apps between test rounds without deleting anything.
# Stops the API and the worker; the database keeps running unless you add
# --with-db. Undo with resume.sh.
#
# Usage:   ./deploy/azure/pause.sh <name>              apps only, database stays up
#          ./deploy/azure/pause.sh <name> --with-db    apps and the database
# Needs:   Azure CLI logged in (az login), the containerapp extension.
#
# While paused:
#   - The address answers nothing; a stopped app does not wake on a request.
#   - Uploads cannot be made; jobs the worker was running are recovered at its next start.
#   - Still charged: the database (unless --with-db; its storage always), the file share,
#     the registry, the log workspace. Azure starts a stopped database again after 7 days.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NAME="${1:?usage: pause.sh <name> [--with-db]}"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{2,13}$ ]] || { echo "name must be 3-14 chars: lowercase letters, digits, hyphens, starting with a letter" >&2; exit 1; }
WITH_DB=0
case "${2:-}" in
  "") ;;
  --with-db) WITH_DB=1 ;;
  *) echo "unknown option: $2 (only --with-db)" >&2; exit 1 ;;
esac

RG="rg-$NAME"
SUB_SHORT="$(az account show --query id -o tsv | tr -d '-' | cut -c1-6)"
PG="pg-${NAME}-${SUB_SHORT}"
APPS=("api-$NAME" "worker-$NAME")
# shellcheck source=_apps.sh
source "$HERE/_apps.sh"

for app in "${APPS[@]}"; do
  az containerapp show -g "$RG" -n "$app" -o none 2>/dev/null || { echo "$app not found in $RG. Is '$NAME' deployed?" >&2; exit 1; }
done

echo "== Stopping the API and the worker"
for app in "${APPS[@]}"; do
  if [[ "$(app_status "$app")" == "Stopped" ]]; then echo "   $app: already stopped"; continue; fi
  app_action "$app" stop
done
FAILED=0
for app in "${APPS[@]}"; do
  if wait_app_status "$app" Stopped; then echo "   $app: stopped"; else FAILED=1; fi
done
[[ "$FAILED" == "0" ]] || echo "   Check in the portal (the app's Overview page) and run this again." >&2

if [[ "$WITH_DB" == "1" ]]; then
  echo "== Stopping the database $PG"
  STATE="$(az postgres flexible-server show -g "$RG" -n "$PG" --query state -o tsv)"
  if [[ "$STATE" == "Stopped" ]]; then
    echo "   already stopped"
  else
    az postgres flexible-server stop -g "$RG" -n "$PG" -o none
    echo "   stopped (Azure starts it again by itself after 7 days)"
  fi
else
  echo "   database $PG left running"
fi

echo
echo "Paused. To start again: ./deploy/azure/resume.sh $NAME"
exit "$FAILED"
