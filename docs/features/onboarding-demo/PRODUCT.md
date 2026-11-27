# First-run onboarding and guided demo

**Status:** Proposal for review · **Baseline:** [main at 437c43a](https://github.com/regevha/service-ledger/commit/437c43a437b304530f532fa04a8886e2c79252d7)

A new editor should be able to check extracted fields against a service report, finalize a report from their own lab, and find it in the instrument's history. A guided demo should show the same workflow in five to seven minutes, including what happens when a field needs a person's judgment.

## What we can reuse

- Home already accepts uploads and links to reports awaiting review. Intake supports translation review for Hebrew reports and can proceed directly to extraction when the instrument and template resolve. The [intake success screen](../../../frontend/src/components/intake/DoneScreen.tsx) links to the report and the instrument.
- [PR #371](https://github.com/regevha/service-ledger/pull/371) explored a synthetic sample with a prepared extraction and a deliberately flagged field. The implementation was set aside. This proposal retains the interaction and uses a bundled scan and review fixture with temporary client-side state.
- [API startup](../../../backend/app/main.py) seeds a fixed fleet and default templates. A fresh lab installation needs the catalog and template defaults with an empty fleet. Existing installations keep their instruments and linked reports.
- The [October walkthrough](../../demo-script.md) gives us a starting narrative. Its run instructions assume the stub reader. Verify the new walkthrough against the release being demonstrated.

## First-run experience

For a lab with no finalized reports, make **Upload a service report** the primary action on Home and offer **Try a sample report** alongside it. If the first upload is already in progress, let the editor resume it. Keep the sample discoverable from New report for editors who join an active lab.

Open the sample directly in the review layout with a synthetic scan and a prepared extraction. Label it as a sample with prepared results. Opening it requires no upload or model call. Let the editor check a flagged field against the source, then make **Upload your own report** the next action. Leaving the sample clears its temporary state. Reopening starts a fresh exercise.

Use the standard intake for the first real upload. If a recognized report has no matching instrument, prefill the known details in the add-instrument form and let the editor confirm before continuing with the same file. Keep the existing manual choice for ambiguous matches. If the report needs a missing template, offer the existing template setup action and a route back to the upload. Keep a visible route back to a report that is still being read or waiting for review. After finalization, point the editor to the instrument history so they can find the new visit.

For an active lab, start an editor with reports awaiting review or a new upload. Once [Phase 4](../../PLAN.md#wave-c-phase-4-per-user-sign-in) ships, a lab editor adds users ahead of time and users sign in with Microsoft Entra ID. A read-only user starts with report search or instrument history. Before opening external access, verify both roles across report views, original scans and exports. If the pilot spans independent labs, decide between separate installations and verified data scoping before granting access.

## Guided demo

Use a dedicated demo installation with its own database and attachment storage. Prepare an instrument with a few finalized visits, a repair report ready for review, and a separate Hebrew PDF for live upload. Use wholly invented details. Give the presenter a repeatable way to restore the demo installation to its starting state.

| Time | Presenter action | What the audience sees |
| --- | --- | --- |
| 0–2 min | Open the prepared report. Compare one flagged field with the scan, correct or confirm it, and finalize. | Where extraction saves time and where the reviewer makes the decision. |
| 2–4 min | Open the instrument's history from the report view and find the new visit through report search. | A service visit becomes part of a record the lab can find later. |
| 4–7 min | When Hebrew intake matters to the audience, upload the synthetic Hebrew PDF and show translation review. | Where the translation is checked before classification and extraction continue. |

Before a local live demo, start PostgreSQL, the API, the worker and the frontend for the intended checkout. Check the readiness endpoint and the frontend. Verify that the API and worker use Local Codex, the worker picks up a job, and a synthetic Hebrew upload reaches translation review through the UI. Tell the audience which report was prepared and which upload ran live. If the provider fails or the read exceeds the slot, report it and continue with the prepared report.

## Delivery order and acceptance

| Step | Deliverable | Acceptance |
| --- | --- | --- |
| 1 | Prepare and rehearse the guided demo on current main. | Two runs start from the same synthetic state. The presenter can finalize the prepared report, find it in history and search, and reach translation review with a separate live Hebrew upload. Restoration is scoped to the demo installation. |
| 2 | Add first-run entry, sample review and clean lab initialization. | On desktop and phone, editors can open the sample, check a flagged field, and continue to real upload. The exercise leaves no rows, stored attachments, counts or exports in the ledger. A fresh lab starts with defaults and an empty fleet. Restarting an existing installation preserves its fleet and reports. |
| 3 | Close gaps found in first-report trials. | Observe three to five new users. Aim for under one minute from entry to opening sample review. Record by hand whether each person independently finalizes a synthetic upload and finds it in instrument history. Record where they get stuck. |
| 4 | Add role-aware entry with Phase 4 and verify external pilot readiness. | An invited editor completes the write flow. An invited read-only user finds and views a report within their access. External access follows the existing Phase 4 gate and the chosen pilot data boundary. |

Reading progress and review continuity already appear in the [product briefing](https://github.com/regevha/service-ledger/blob/nir/regev-briefing-feature-details/docs/regev-briefing/README.md). Slot them in where trials show that users need help following the read or resuming review. Introduce batch grouping, email intake and template configuration at the point where the user needs them.

Review the proposed demo sequence, the audience for the live Hebrew segment, and the trial targets before scheduling implementation.
