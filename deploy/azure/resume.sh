#!/usr/bin/env bash
# Starts an environment paused with pause.sh: the database first (if it was
# stopped) and waits until it is ready, then the API and the worker. Jobs that
# were running when the worker stopped are recovered at its start (its log says
# "Recovered N job(s)").
#
# Usage:   ./deploy/azure/resume.sh <name>
# Needs:   Azure CLI logged in (az login), the containerapp extension.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NAME="${1:?usage: resume.sh <name>}"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{2,13}$ ]] || { echo "name must be 3-14 chars: lowercase letters, digits, hyphens, starting with a letter" >&2; exit 1; }

RG="rg-$NAME"
SUB_SHORT="$(az account show --query id -o tsv | tr -d '-' | cut -c1-6)"
PG="pg-${NAME}-${SUB_SHORT}"
APPS=("api-$NAME" "worker-$NAME")
# shellcheck source=_apps.sh
source "$HERE/_apps.sh"

for app in "${APPS[@]}"; do
  az containerapp show -g "$RG" -n "$app" -o none 2>/dev/null || { echo "$app not found in $RG. Is '$NAME' deployed?" >&2; exit 1; }
done

echo "== Database $PG"
STATE="$(az postgres flexible-server show -g "$RG" -n "$PG" --query state -o tsv)"
if [[ "$STATE" == "Stopped" ]]; then
  echo "   stopped, starting it (this takes a few minutes)..."
  az postgres flexible-server start -g "$RG" -n "$PG" -o none
fi
for _ in $(seq 1 60); do
  STATE="$(az postgres flexible-server show -g "$RG" -n "$PG" --query state -o tsv 2>/dev/null || true)"
  [[ "$STATE" == "Ready" ]] && break
  sleep 10
done
[[ "$STATE" == "Ready" ]] || { echo "The database is not ready (state: ${STATE:-unknown}); the apps were not started. Run this again in a few minutes." >&2; exit 1; }
echo "   ready"

echo "== Starting the API and the worker"
for app in "${APPS[@]}"; do
  if [[ "$(app_status "$app")" == "Running" ]]; then echo "   $app: already running"; continue; fi
  app_action "$app" start
done
FAILED=0
for app in "${APPS[@]}"; do
  if wait_app_status "$app" Running; then echo "   $app: running"
  else FAILED=1; echo "   Check: az containerapp logs show -g $RG -n $app --tail 50" >&2; fi
done

echo
echo "Resumed. Worker log: az containerapp logs show -g $RG -n worker-$NAME --tail 20"
exit "$FAILED"
