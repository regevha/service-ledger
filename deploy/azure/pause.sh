#!/usr/bin/env bash
# Stops paying for the apps between test rounds without deleting anything.
# Scales the API and the worker to zero copies; the database keeps running
# unless you add --with-db. Undo with resume.sh.
#
# Usage:   ./deploy/azure/pause.sh <name>              apps only, database stays up
#          ./deploy/azure/pause.sh <name> --with-db    apps and the database
# Needs:   Azure CLI logged in (az login), the containerapp extension.
#
# While paused:
#   - The API wakes by itself on the first request (a few seconds' cold start). With the
#     database up it then works; with --with-db it cannot reach the database.
#   - The worker does not wake by itself: uploads wait at "pending" until resume.sh.
#   - Still charged: the database (unless --with-db; its storage always), the file share,
#     the registry, the log workspace. Azure starts a stopped database again after 7 days.
set -euo pipefail

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

for app in "${APPS[@]}"; do
  az containerapp show -g "$RG" -n "$app" -o none 2>/dev/null || { echo "$app not found in $RG. Is '$NAME' deployed?" >&2; exit 1; }
done

echo "== Scaling the apps to zero"
for app in "${APPS[@]}"; do
  az containerapp update -g "$RG" -n "$app" --min-replicas 0 -o none
  echo "   $app: minimum 0"
done

echo "   waiting for the running copies to stop..."
for app in "${APPS[@]}"; do
  COUNT=""
  for _ in $(seq 1 30); do
    COUNT="$(az containerapp replica list -g "$RG" -n "$app" --query 'length(@)' -o tsv 2>/dev/null || echo "?")"
    [[ "$COUNT" == "0" ]] && break
    sleep 10
  done
  if [[ "$COUNT" == "0" ]]; then echo "   $app: stopped"
  else echo "   $app: still $COUNT running after 5 minutes; it will stop on its own (check: az containerapp replica list -g $RG -n $app -o table)"; fi
done

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
