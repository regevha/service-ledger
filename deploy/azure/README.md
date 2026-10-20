# Azure setup for a few testers

Scripts that create the Azure side of ServiceLedger. The plan and the reasons
behind each choice are in the project doc `claude/proposal-azure-deployment.md`.

**Status: written but never run against a real Azure subscription.** It was
dry-run with a stand-in `az` command to check the flow and the generated YAML,
and it needs a first real run with the project owner watching.

## What `deploy.sh` creates (one resource group, `rg-<name>`)

- PostgreSQL Flexible Server (Burstable B1ms, version 16), database `service_ledger`; reachable from Azure services only
- Storage account with an Azure Files share, mounted at `/data` in both apps (`ATTACHMENT_STORAGE_DIR=/data/attachments`, so no code change)
- Container registry, Container Apps environment, log workspace
- A manual job that runs `alembic upgrade head`
- The API app (`uvicorn app.main:app`) and the worker app (`python -m app.worker`), one replica each, always on (the worker polls)
- Secrets (database URL, API key, registry password) as Container Apps secrets; nothing is written to a file in the repo

## What it does not do (still to build)

1. **`backend/Dockerfile`.** It must put `alembic.ini`, `alembic/` and `app/` in the working directory, because the migration job runs `alembic upgrade head` there. Then run with `BUILD_IMAGE=1`, or push the image yourself.
2. **The built frontend**, served by the API container (same address, so no CORS question).
3. **The shared-password gate.** Until it exists the script keeps ingress **internal** (nobody can reach the app from the internet). `INGRESS=external` asks for confirmation because the app has no sign-in.

## Use

```
az login
./deploy/azure/deploy.sh sl-test            # from the repository root
az containerapp job start -g rg-sl-test -n job-migrate-sl-test
ANTHROPIC_API_KEY=... ./deploy/azure/deploy.sh sl-test   # live Claude (environment variable only)
./deploy/azure/destroy.sh sl-test           # stop paying; deletes the database and attachments
```

Optional: `LOCATION` (default `westeurope`, a decision for the project owner), `IMAGE_TAG`, `INGRESS`, `BUILD_IMAGE`.

Not covered: re-running over an existing deployment (create commands will report what already exists), custom domain, backups of the file share, Key Vault (secrets are Container Apps secrets for now).
