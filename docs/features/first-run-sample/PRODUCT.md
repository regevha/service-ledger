# First run reaches the aha moment: sample report (sections A and B)

Source: the owner's proposal "First run reaches the aha moment fast" (project doc `claude/proposal-first-run-aha.md`, 2026-11-20). This brief covers its sections **A** (sample report) and **B** (demo instrument). Sections C to F are separate briefs.

## The aha moment
A new user sees one service form become checked, structured fields next to the scan, on the review screen, for a document they did not have to retype. Primary metric: time from the first page after the shared password to that screen (target under 60 s with the sample), measured by hand with a stopwatch and recorded in the demo run sheet. **No tracking code is added.**

## Decisions (owner, 2026-11-20)
- D-1 The shared password stays. No sandbox.
- D-2 Time-to-aha is measured by hand.
- D-3 **The sample is a synthetic form, not a BD scan** (changed from the proposal, same day, when the six BD Test Set files were not reachable and the repo is public). Every value is invented: no real name, serial, institution, work order or contact. It carries one or two low-confidence fields so flags are part of the first impression.
- D-4 The sample ships with a **pre-computed extraction result**. No Claude call, no API spend.

## Scope
### A. "Try with a sample report"
- The New report screen shows a primary button **Try with a sample report** beside the upload box when the ledger has **no finalized reports** (samples never count).
- The button opens the review screen straight away, with fields filled in, flags shown and the "N of M checked" counter working. Clicking it again opens the same sample (one sample at a time).
- AC-01 The sample reaches the review screen in under 5 seconds on a normal connection, with no Claude call.
- AC-02 The review screen of a sample shows a banner: "Sample report. Not part of your ledger." with a **Delete** button. A sample cannot be finalized and cannot be re-read (a clear message says why).
- AC-03 Sample data is excluded from: the Reports list and its search and filters, CSV export, Analytics, Home figures (waiting for review included), maintenance-due badges, duplicate checks, the instrument, place and model lists and counts, and the fleet given to the classifier.
- AC-04 One click on Delete removes the sample report, its scan, and its demo instrument and demo place. A single reusable function (`remove_sample_data`) removes every sample, for the future start-clean step (US-8.8, not built).

### B. Demo instrument
- The sample report belongs to a demo instrument in a demo place, so "serial not on file" never shows on the sample path.
- AC-05 The demo instrument and place are created only when the sample is opened (never by seeds or startup), and are marked as sample. They fall under the same exclusions as AC-03.

## Not in scope
Auto-continue past the confirm step (C), deferring the name field (D), add-instrument prefill (E), the post-aha call to action (F), tracking, tours, removing the password, a BD or any real-vendor scan in the repo.

## Risks
- A sample row leaking into a real count or export. Mitigation: one `is_sample` flag, one test per place listed in AC-03.
- The sample oversells: it always reads perfectly. Mitigation: one or two flagged fields on purpose.
- The sample's template goes missing or changes. Mitigation: the stored result uses only the generic repair template's field names, and a test fails if one is missing.
- Migration number clash with other open PRs (0017 is used by #305): renumber at merge.
