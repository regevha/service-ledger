# Email intake implementation

The [product brief](PRODUCT.md) records the November 13 decisions. The
[API](API.md), [data model](DATA_MODEL.md), and [design](DESIGN.md) carry the
original contracts. The old SL-61 through SL-88 identifiers refer to the
original branch and are superseded by the specs below.

## Deployment decision (2026-11-27)

Use a dedicated Gmail inbox and the ServiceLedger poller. Run
`python -m app.email_poller --once` in a scheduled Azure Container Apps Job
every minute. Gmail receives the messages, Azure schedules the checks, and
ServiceLedger verifies the sender and PDF, prevents duplicates, creates a
draft for human review, and sends a receipt. The poller runs in the app's
Container Apps environment, so the API can keep internal ingress.
[Azure Container Apps Jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs)

Azure Logic Apps has Gmail and Outlook triggers. For a consumer Gmail
account, the HTTP or Azure Blob Storage handoff requires a separate
Google OAuth app. Calling ServiceLedger also needs a private network
path. The scheduled poller keeps message handling and retries in
ServiceLedger and reuses the code on this branch.
[Gmail connector](https://learn.microsoft.com/en-us/connectors/gmail/)
· [Google connector restrictions](https://learn.microsoft.com/en-us/azure/connectors/connectors-google-data-security-privacy-policy)

If the organization adopts Exchange Online for the mailbox, a shared
mailbox with Microsoft Graph is an alternative. It would require a Graph
adapter and a mailbox-scoped identity. Azure Communication Services
Email supplies outbound delivery only.
[Exchange application permissions](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
· [Azure Email API](https://learn.microsoft.com/en-us/rest/api/communication/email/email)

## Verification status

**Live mailbox not connected. Live end-to-end (E2E) test not run.**
Local verification used synthetic `.eml` files, a folder outbox, and an
isolated database. The Azure intake job is still pending provisioning
and verification. Follow the [runbook](DEMO.md) to verify actual
Gmail delivery, draft creation, and the sender's receipt.

## Implementation tasks

1. SL-120 ports the data model and adds migration and constraint checks.
2. SL-121 ports the MIME parser and PDF checks and adds folder and Gmail
   adapters. The Gmail demo uses a dedicated inbox, IMAP and SMTP over TLS,
   and an app password. The mailbox moves handled mail to Trash after the
   database commits. The mailbox owner controls permanent retention.
3. SL-122 adds the one-shot poller, worker integration, held-file and
   allow-list operations, and the report API. The poller runs
   independently of the report worker in both deployment modes. For an
   on-demand worker, it wakes the worker after commit. The folder and
   Gmail adapters use the same intake flow.
4. SL-123 adds the intake administration and report continuation screens.
5. Verify the synthetic flow from inbox to human review, including replay,
   mixed results, held release, job limit recovery, and export privacy.
   Then run the dedicated Gmail smoke test with the mailbox owner.

Enable the feature explicitly in a trusted internal deployment. Shared
HTTP Basic access is the current demo boundary. Named user attribution
and admin-only enforcement depend on the separately planned sign-in
work. A production mail provider and malware scanner remain follow-ups.
