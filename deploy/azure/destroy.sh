#!/usr/bin/env bash
# Deletes everything deploy.sh created (the whole resource group). Irreversible:
# the database and the uploaded attachments go with it.
set -euo pipefail
NAME="${1:?usage: destroy.sh <name>}"
RG="rg-$NAME"
read -r -p "Delete resource group $RG with its database and attachments? Type the name to confirm: " ans
[[ "$ans" == "$NAME" ]] || { echo "not confirmed"; exit 1; }
az group delete -n "$RG" --yes --no-wait
echo "Deletion of $RG started."
