# Stopping and starting the API and worker apps (sourced, not run; needs RG set).
# Container Apps has real stop and start operations: a stopped app runs no copies and
# does not wake on a request. The CLI has no command for them, so they go through az rest.

APP_API_VERSION="2024-03-01"

app_action() {  # $1 app  $2 stop|start
  local id; id="$(az containerapp show -g "$RG" -n "$1" --query id -o tsv)"
  az rest --method post --url "https://management.azure.com${id}/$2?api-version=$APP_API_VERSION" -o none
}

app_status() {  # $1 app; prints Running, Stopped, or a transition state
  az containerapp show -g "$RG" -n "$1" --query properties.runningStatus -o tsv 2>/dev/null || true
}

wait_app_status() {  # $1 app  $2 Stopped|Running; returns 1 if it is not reached in 5 minutes
  local status=""
  for _ in $(seq 1 30); do
    status="$(app_status "$1")"
    [[ "$status" == "$2" ]] && return 0
    sleep 10
  done
  echo "   $1 is '${status:-unknown}', not $2, after 5 minutes" >&2
  return 1
}
