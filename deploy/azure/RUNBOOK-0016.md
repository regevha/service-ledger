# Runbook: migration 0016 (relative attachment paths), restore test and production rollout

Decision D-11: 0016 is tested first on a restored copy of a recent backup in a **non-production** environment, then rolled out to production in a window you pick, with a backup first and `restore.sh` as the fallback. You run every step; nothing here is run by the team.

What 0016 does: `attachments.file_path` changes from a full path (`/data/attachments/<report id>/<uuid>.pdf`) to a path relative to `ATTACHMENT_STORAGE_DIR` (`<report id>/<uuid>.pdf`). Rows whose path is **outside** `ATTACHMENT_STORAGE_DIR` are left exactly as they are (D-9); the migration neither stops nor fails on them. Downgrade turns relative paths back into full paths under the current root. The migration touches only the database, never the files on the share.

**Read this first: these scripts have never run against a real Azure subscription** (see `README.md`; only `pause.sh` for the apps has). So step 1, creating the non-production environment, is itself the first real test of `deploy.sh`, `backup.sh`, `restore.sh` and `update.sh`. Expect to fix script problems; stop and report rather than improvising on production.

Legend: **[script]** = a command in `deploy/azure/*.sh`. **[unchecked]** = a plain `az`/`psql` command written for this runbook that no script contains and nobody has run; read the output carefully.

Names: `<src>` is the existing environment you back up (production), `<test>` a new throwaway name (3-14 chars, lowercase letters, digits, hyphens), `<prod>` is `<src>` again at the rollout. All commands run from the repository root, after `az login`, on the commit you intend to release.

## 0. Blocker to clear before step 5 (found while writing this)

`deploy.sh` creates the migration job `job-migrate-<name>` with only `DATABASE_URL`; `ATTACHMENT_STORAGE_DIR` and the `/data` mount are set on the API and worker apps only. 0016 finds the storage root from `ATTACHMENT_STORAGE_DIR`, so in that job it would use the default `./storage/attachments`, treat every row as "outside" and change nothing, or fail creating a folder it may not write. The app would still read the old full paths, so nothing breaks, but the migration would not have done its work. **Do not run production until the job has the variable and the mount.** This needs a change in `deploy.sh`/`update.sh` (devops request in the hand-off). Step 5 checks it, and step 7 proves the result.

Check [unchecked]:
```
az containerapp job show -g rg-<test> -n job-migrate-<test> \
  --query "properties.template.containers[0].{env:env,mounts:volumeMounts}" -o json
```
You need `ATTACHMENT_STORAGE_DIR` = `/data/attachments` in `env` and a mount at `/data`. If not, stop here.

## 1. Create the non-production environment

```
./deploy/azure/deploy.sh <test>          # [script] add BUILD_IMAGE=1 for the first run (builds frontend and image)
```
Keep ingress internal (default). It costs money while it exists; `./deploy/azure/destroy.sh <test>` [script] deletes it (and its data) at the end. Note the shared password it prints once.

## 2. Take a backup of the source environment

```
./deploy/azure/backup.sh <src>           # [script] -> backups/<src>-<UTC time>/
```
Check the printed MANIFEST: `migration:` should be `0015_indexes` (or earlier) if 0016 is not yet released, and `attachments` / `scan files` counts should be plausible. Write down the `attachments:` count. The folder holds real data and is not encrypted: keep it private.

## 3. Count rows outside the storage root (before)

Open a shell that reuses the scripts' connection helpers [script functions, used in a way no script does; unchecked]:
```
bash
set -- <test>; source deploy/azure/_common.sh; open_database
psql -c "select count(*) as total, count(*) filter (where file_path not like '/data/attachments/%') as outside_root from attachments"
```
Stay in this shell for steps 5-7 (it holds the database firewall rule and credentials). Run `close_database; exit` at the end of step 7. Do this only after step 4 (the database must hold the restored data); the line above is shown here to explain the check.

## 4. Restore the backup into the test environment

```
./deploy/azure/restore.sh <test> backups/<src>-<UTC time>     # [script]
```
It asks you to type `<test>`, takes a safety backup of the (empty) test state, stops the apps, replaces the database and copies the scans to the share, then starts the apps. The test environment is now on the old schema with new code; do not open it until step 5 is done. Then run the count from step 3: `total` must equal the manifest's `attachments`; write down `outside_root` (D-9: these rows stay as they are).

## 5. Run 0016 in the test environment (upgrade)

Confirm the step 0 check passes, then:
```
./deploy/azure/update.sh <test>          # [script] builds, runs the migration job, waits, rolls the apps
```
Or, to migrate without a new image, start the job only [unchecked in this use]:
```
az containerapp job start -g rg-<test> -n job-migrate-<test>
```
Job log if it fails: `az containerapp job logs show -g rg-<test> -n job-migrate-<test> --container job-migrate-<test>` (printed by `update.sh`).

## 6. Verify the upgrade

In the shell from step 3:
```
psql -c "select version_num from alembic_version"        # 0016_relative_attachment_paths
psql -c "select count(*) filter (where file_path like '/%') as still_absolute, count(*) filter (where file_path not like '/%') as relative from attachments"
```
Expected: `still_absolute` equals `outside_root` from step 4 and `relative` equals `total` minus that. If `still_absolute` equals `total` the job did not know the storage root (step 0): stop. Also check a few relative values by eye: `psql -c "select file_path from attachments limit 5"` should look like `<report id>/<uuid>.pdf`.

## 7. Downgrade, upgrade again, and check the app opens attachments

There is no script for downgrade. The cycle below runs `alembic` through the migration job by changing its arguments [unchecked]. **Always finish by restoring the arguments**: `update.sh` only changes the job's image, so a job left on `downgrade` would downgrade production on the next release.
```
az containerapp job update -g rg-<test> -n job-migrate-<test> --args "downgrade" "0015_indexes"
az containerapp job start  -g rg-<test> -n job-migrate-<test>        # wait until the execution shows Succeeded
psql -c "select version_num from alembic_version"                    # 0015_indexes
psql -c "select count(*) filter (where file_path like '/%') as absolute from attachments"   # equals total
az containerapp job update -g rg-<test> -n job-migrate-<test> --args "upgrade" "head"
az containerapp job start  -g rg-<test> -n job-migrate-<test>        # wait until Succeeded
```
Wait for an execution with `az containerapp job execution list -g rg-<test> -n job-migrate-<test> --query "[0].properties.status" -o tsv` [unchecked; `update.sh` uses the `show` form]. Then repeat the step 6 queries: same numbers as after the first upgrade. Confirm the arguments are back: `az containerapp job show -g rg-<test> -n job-migrate-<test> --query "properties.template.containers[0].args" -o tsv` must show `upgrade head`. Then `close_database; exit`.

Check the app opens attachments: open a finalized report that has a scan, in the test environment, and open its attachment (no errors, the PDF shows), plus one report from before and one uploaded now. Ingress is internal, so the address printed by `update.sh` is reachable only from inside the virtual network; **how you reach it from your machine is not covered by any script [unchecked]**. Do not switch a copy of real data to `INGRESS=external` just for this unless you accept that it is protected by one shared password only. If you cannot reach it, say so and treat this check as not done; the step 6 numbers do not prove files open.

If a row was outside the root (step 4 count above 0), open one such attachment too: it should behave as before the migration (it works or fails exactly as it did, because it was left as it was).

## 8. Production window (after steps 1-7 all passed)

1. Pick a quiet window; tell testers the app is unavailable for the length of the release. Re-check step 0 on `job-migrate-<src>`.
2. Backup and release in one command:
   ```
   BACKUP_FIRST=1 ./deploy/azure/update.sh <src>       # [script]
   ```
   Note the backup folder it prints. If the migration fails, the apps keep running the old image (`update.sh` says so); nothing more to do except read the job log.
3. Repeat the step 6 checks against `<src>` (open the shell with `set -- <src>`), and open an attachment in the app.
4. **Fallback** if anything is wrong after the release:
   ```
   ./deploy/azure/restore.sh <src> backups/<src>-<UTC time>     # [script] the backup from item 2
   ```
   This replaces the database with the pre-release backup (anything saved since is lost) and copies the scans back. The apps then run the new image on the old schema with full paths; the new code still reads full paths, so they keep working. To go back to the old code too, check out the earlier commit and run `./deploy/azure/update.sh <src>` (note: that runs `alembic upgrade head` with the old image, which has no 0016, and does nothing to a database at 0015).
5. Keep the backup folder until you are sure, then store it somewhere private.

## 9. Clean up

`./deploy/azure/destroy.sh <test>` [script]. Delete or securely store the backup folders: they hold real lab data.
