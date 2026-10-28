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
- A manual job that runs `alembic upgrade head`; the script starts it and waits for it to succeed before it creates the API and worker (after a new release, start it again by hand)
- The API app (`uvicorn app.main:app`, serving the built frontend and asking for the shared password) and the worker app (`python -m app.worker`), one replica each, always on (the worker polls)
- Secrets (database URL, API key, registry password) as Container Apps secrets; nothing is written to a file in the repo

## What it does not do

1. **Build or test the image on the official base.** `backend/Dockerfile` was tested on a stand-in base only. Run the script with `BUILD_IMAGE=1` (it builds the frontend with `npm`, then the image in the registry), or build and push it yourself. Still unchecked: that the container user (id 10001) can write to the mounted Azure Files share.
2. **Accounts.** The app has one shared password (HTTP Basic, any user name): it keeps strangers out, it does not say who did what, and changing it locks everyone out at once. The script generates a password if you do not pass `SHARED_PASSWORD` (12 characters at least) and prints it once. Ingress stays **internal** unless you pass `INGRESS=external`, which asks for confirmation.
3. **Rate limiting.** There is none; the password length is the protection against guessing. Wrong attempts are logged.

## Use

```
az login
./deploy/azure/deploy.sh sl-test            # from the repository root
ANTHROPIC_API_KEY=... ./deploy/azure/deploy.sh sl-test   # live Claude (environment variable only)
./deploy/azure/destroy.sh sl-test           # stop paying; deletes the database and attachments
```

Optional: `LOCATION` (default `westeurope`, a decision for the project owner), `IMAGE_TAG`, `INGRESS`, `BUILD_IMAGE`.

**If a first run stops half way** (a build error, a timeout), fix the cause and run the same command again. It keeps what already exists (environment, storage and share, Postgres server and database, registry), sets a new database admin password (the earlier one was never stored), replaces the migration job and carries on. It refuses once `api-<name>` or `worker-<name>` exists: a running environment is changed only through `update.sh`, `set-secrets.sh` or `restore.sh`. If the API app was created but the worker was not, run `destroy.sh` and start again.

Not covered: custom domain, automatic backups of the file share (use `backup.sh` below), Key Vault (secrets are Container Apps secrets for now).

## Changing the API key or the shared password

```
./deploy/azure/set-secrets.sh sl-test key        # new Anthropic key; turns live Claude on (API and worker)
./deploy/azure/set-secrets.sh sl-test key-off    # back to stub mode, no model calls
./deploy/azure/set-secrets.sh sl-test password   # new shared password (API); empty answer = generate one
```

The value comes from `ANTHROPIC_API_KEY` / `SHARED_PASSWORD` if set, otherwise you type it (hidden). Nothing is written to a file or printed back, except a generated password, shown once. Each change creates a new revision, so the old value stops working a few seconds later. The password must be at least 12 characters. Not yet run against real Azure.

## Updating a running environment

After a code change (merged or on your branch), roll it out without recreating anything:

```
./deploy/azure/update.sh sl-test
```

It builds the frontend and a new image (tagged with the commit and the time), runs the migration with that image and waits for it, then points the API and the worker at the new image. The database, attachments, password and API key are untouched. If the migration fails, the apps keep running the old image. To go back, check out the earlier commit and run it again. Not yet run against real Azure.

## Backing up and restoring

```
./deploy/azure/backup.sh sl-test                         # -> backups/sl-test-<UTC time>/
./deploy/azure/restore.sh sl-test backups/sl-test-20261025-203000Z
BACKUP_FIRST=1 ./deploy/azure/update.sh sl-test          # backup, then release
```

`backup.sh` writes a folder with `database.dump` (the whole database), `attachments/` (every scanned file from the share), `MANIFEST.txt` (migration version and row counts) and `SHA256SUMS`. Keep the folder together: the database stores only the paths of the scans. The database allows Azure services only, so the script opens it to this machine's address for the length of the run and closes it again. It needs the Azure CLI, `pg_dump`/`pg_restore`/`psql` version 16 or newer, and `curl`. `NO_FILES=1` skips the scans.

`restore.sh` checks the checksums, shows the manifest, asks you to type the environment name, takes a safety backup of the current state (`backups/<name>-before-restore-...`), stops the API and worker, replaces the database in one transaction (a failure leaves it as it was), copies the scans back, and starts the apps again. Anything saved after the backup is lost. If the backup is older than the deployed code, run `update.sh` afterwards so the migration brings the schema up to date.

The dump is **not encrypted** and holds real lab data; `backups/` is ignored by git, but store the folder somewhere private. Azure also keeps its own automatic database backups (7 days by default; raise with `az postgres flexible-server update --backup-retention 35`). Not yet run against real Azure; the dump and restore commands were tried against a local PostgreSQL.
