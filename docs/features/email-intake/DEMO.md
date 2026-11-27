# Demo report uploads by email

Use an isolated local database and synthetic reports. The app creates a
draft and a receipt. A person still approves the report in ServiceLedger.

**Current status:** A live mailbox has yet to be connected and the live
end-to-end (E2E) test has yet to run. The local demo uses synthetic
`.eml` files and a folder outbox. The Azure schedule below is the
agreed deployment plan.

## Start with the folder inbox

Follow the [local backend setup](../../../backend/README.md). In WSL or
Linux, activate the backend virtual environment and run
`alembic upgrade head` against the demo database. Set the following in the
ignored `backend/.env` file.

```dotenv
EMAIL_INTAKE_ENABLED=true
EMAIL_MAILBOX=folder
EMAIL_SENDER=folder
EMAIL_INTAKE_ADDRESS=intake@example.invalid
EMAIL_FAKE_INBOX_DIR=./storage/email/inbox
EMAIL_FAKE_OUTBOX_DIR=./storage/email/outbox
USE_LIVE_CLAUDE=false
```

Start the API and frontend. Start `python -m app.worker` in a separate
terminal, or set `WORKER_TRIGGER=local` in `backend/.env` for on-demand
reading. In **Admin → Email intake → Allowed senders**, add
`flow-team@example.org` with a team label. Then run these commands from
`backend/` with the same environment.

```bash
python -m app.tools.email_demo_send --from flow-team@example.org /path/to/synthetic-report.pdf
python -m app.email_poller --once
```

Use `python -m app.email_poller --watch` to read repeatedly during a local
demo. The watcher is separate from the report worker. Each handled
`.eml` is removed from the inbox after commit. Notifications are written
to `EMAIL_FAKE_OUTBOX_DIR`; the demo does not open an SMTP connection.
Unknown senders are logged without an address and receive no reply.

Open **Reports**, then a draft marked **By email**. A known text PDF with
a matching unit and template can be read automatically. If it requires a
template or translation, use **Continue**. Review the data and finalize
in the app. Files with no readable text appear under **Held for a check**,
where they can be released or deleted.

## Connect the dedicated Gmail inbox

1. Create a dedicated Gmail account, turn on 2-Step Verification, and
   create a Gmail app password named **ServiceLedger demo**. Use the
   [Google app-password help](https://support.google.com/mail/answer/185833)
   if the option is missing. For a managed account, the organization must
   allow the selected method. For the first live test, use a standalone
   demo account and send directly from one approved test address.
2. Set the app password in the ignored `backend/.env` file or the
   runtime's secret store. Keep it out of chat, Git, and logs. Reuse the
   app's internal shared password or set a new one for the demo.
3. In Admin, allowlist the test sender's **From** address. Start the
   poller and send one synthetic service report PDF to the new address.
   To complete the live E2E test, confirm the Gmail message was picked
   up, SL shows a draft with its source, the Email log records the
   outcome, and the sender receives a receipt in their inbox. Once
   direct delivery passes, test a forwarded report and a scanned PDF.

```dotenv
EMAIL_INTAKE_ENABLED=true
EMAIL_MAILBOX=imap
EMAIL_SENDER=smtp
EMAIL_INTAKE_ADDRESS=your-dedicated-address@example.invalid
EMAIL_USERNAME=your-dedicated-address@example.invalid
EMAIL_APP_PASSWORD=<Gmail app password>
EMAIL_TRUSTED_AUTHSERV_ID=mx.google.com
EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_IMAP_PORT=993
EMAIL_IMAP_FOLDER=INBOX
EMAIL_IMAP_TRASH_FOLDER=[Gmail]/Trash
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=465
SHARED_PASSWORD=<internal ServiceLedger password>
USE_LIVE_CLAUDE=false
```

Use an empty inbox. The poller handles mail already present as well as new
mail. The IMAP adapter moves handled messages to Trash after commit. It
uses IMAP UID MOVE or UIDPLUS with deletion scoped to that message. Confirm the Trash folder name if Gmail
uses a localized name. SMTP delivery can be ambiguous after a disconnect.
Retries use the same Message-ID, and the intake log records failed sends.

## Schedule a deployed instance

Create a scheduled Azure Container Apps Job in the same environment
as the API. Run `python -m app.email_poller --once` every minute
(`* * * * *`). Give the job access to the same database and attachment
storage as the API, and supply the Gmail credentials as job secrets.
Keep the API on internal ingress. For the on-demand worker, configure
the poller with the existing worker trigger and a managed identity
authorized to start that worker job. The default always-on worker
picks up committed jobs on its own.
[Azure Container Apps Jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs)

Keep `EMAIL_INTAKE_ENABLED=false` on deployments that have not been
configured and tested. The current shared-password demo is for trusted
operators. Production rollout needs a production mailbox, role-based
access and a malware scan in addition to the structural PDF check.
