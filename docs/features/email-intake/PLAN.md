# Email intake implementation

The [product brief](PRODUCT.md) records the November 13 decisions. The
[API](API.md), [data model](DATA_MODEL.md), and [design](DESIGN.md) carry the
original contracts. The old SL-61 through SL-88 identifiers refer to the
original branch and are superseded by the specs below.

1. SL-120 ports the data model and adds migration and constraint checks.
2. SL-121 ports the MIME parser and PDF checks and adds folder and Gmail
   adapters. The Gmail demo uses a dedicated inbox, IMAP and SMTP over TLS,
   and an app password. The mailbox moves handled mail to Trash after the
   database commits. The mailbox owner controls permanent retention.
3. SL-122 adds the one-shot poller, worker integration, held-file and
   allow-list operations, and the report API. The
   poller runs independently of the report worker in both deployment
   modes. For an on-demand worker, it wakes the worker after commit.
   Test mode uses a folder inbox and outbox. Gmail uses the same flow.
4. SL-123 adds the intake administration and report continuation screens.
5. Verify the synthetic flow from inbox to human review, including replay,
   mixed results, held release, job limit recovery, and export privacy.
   Then run the dedicated Gmail smoke test with the mailbox owner.

Enable the feature explicitly in a trusted internal deployment. Shared
HTTP Basic access is the current demo boundary. Named user attribution
and admin-only enforcement depend on the separately planned sign-in
work. A production mail provider and malware scanner remain follow-ups.
