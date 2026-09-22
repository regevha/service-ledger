# ServiceLedger Demo Script

> This is a checked-in copy of the live, editable version at
> https://claude.ai/artifact/1uJXpdK14FtV4pS6rAJkc1 — edit that one and
> re-export here rather than editing this file directly, so the two don't
> drift apart.

A presenter's walkthrough for showing off the app end to end — what to click, what to say, and why it matters. Roughly 25 minutes for the full run; Parts 1–3 alone make a tight 10-minute version, with Part 2 as the one part worth keeping no matter what gets cut.

Everything below runs against the deterministic stub classifier/extractor (no `ANTHROPIC_API_KEY` needed) — same result every time, safe to demo offline.

## Before you start: prep checklist

Everything in this walkthrough runs against a deterministic stub classifier/extractor (`USE_LIVE_CLAUDE=false`, the default), not the live Claude API — same code path, same UI, but free and exactly repeatable. Say this once, near the top, so no one wonders why extraction is instant or thinks the values are made up on the spot.

- **Backend running:** `uvicorn app.main:app --reload` (port 8000).
- **Worker running, in a second terminal:** `python -m app.worker`. Without this, "Upload & classify" and extraction enqueue a job and sit at `pending` forever — nothing else calls `classify()`/`extract()`.
- **Frontend running:** `npm run dev` (Vite, port 5173) — have `http://localhost:5173` already open in a browser tab.
- **Fleet + templates seeded** (idempotent, safe to re-run): `python -m app.seed_instruments && python -m app.seed_templates`.
- **Trend chart data seeded ahead of time**, so Part 7 doesn't depend on live uploads mid-demo: `python -m app.seed_trend_demo` — 5 synthetic FACSAria III calibration reports, two months apart.
- **Optional:** `python -m app.seed_demo_reports` — 3 more finalized reports (real extraction results) so the Reports tab isn't showing only what you upload live.
- **Two fixture files ready to upload**, both already in the repo at `frontend/tests/e2e/fixtures/`: `confident-scan.pdf` (Part 1) and `sample-work-order.pdf` (Part 2 — the centerpiece).

## Part 1: New report, the fast path

This is the report that "just works" — most real uploads land here, and that's the point: it should be boring.

1. Click the **New report** tab (already selected on a fresh load).
2. Type a name into **"Your name (optional)"**.
3. Drop **`confident-scan.pdf`** onto the dropzone (or use the file picker).
4. Click **Upload & classify**.
   - *Say while it runs:* "That kicked off two real backend calls — `classify()`, then `extract()` — both run by the background worker, not the browser."
5. No manual-confirm row appears — both the instrument guess and the report-type guess cleared the 85% classification threshold, so the app resolves the template on its own and jumps straight to the field list.
6. Point out the **field list**: every field has its own small percentage badge ("X% confident") — a per-field *extraction* confidence, distinct from the whole-document *classification* confidence you'll see in Part 2.
7. Click **Save & finalize report**.
8. The success panel confirms the report is finalized.
9. Click **Start another report** to reset the screen for Part 2.

## Part 2: New report, the flagged path — the centerpiece

This is the case worth slowing down for: a real ambiguity in the source document, handled honestly instead of guessed past.

1. Click **New report** if you navigated away, and type a name.
2. Upload **`sample-work-order.pdf`**.
3. Click **Upload & classify**.
4. Two rows appear this time, before extraction runs:
   - **Instrument** — green badge, "96% confident."
   - **Report type** — amber badge, "58% needs review."
   - *Say:* "This filename reproduces a real document from the spec — an actual BD Care EU work order. The serial number is a clean read, so the instrument guess is confident. But repair, preventive maintenance, and calibration reports share almost the same layout on this vendor's forms, so which one this is is a genuinely harder call — and the system says so instead of picking one silently."
5. Click **Confirm & continue**. (Note in passing: this is the same button that would let you *override* an incorrect confident guess — it's not only for the low-confidence case.)
6. Extraction runs against the resolved template. On the review screen, point at three fields:
   - **fault category** — already set to "fluidics" from the extracted text.
   - **work performed** — a full paragraph pulled straight from the document, about the fluidics path and the sample injector O-ring.
   - **root cause** — blank, with a highlighted "pending" state around the field. This value genuinely isn't on the source document — the model correctly declined to invent one rather than guess, and it's flagged for a human to fill in.
7. Type something into **root cause** yourself (e.g. "Sample injector O-ring degraded") to close the loop on the correction workflow.
8. Click **Save & finalize report**.

**Talking point to land here:** the confidence badges and the pending-field highlight aren't cosmetic — they're the trust boundary of the whole product. A technician reviewing this report only has to double-check the two or three fields the system is telling them it's unsure about, not re-read the entire scan against every field.

## Part 3: Reports tab

1. Click the **Reports** tab.
2. Point out the filter row: instrument, report type, status — all three combine (every filter narrows the result, not an either/or).
3. Filter by report type or status to something that matches — the reports finalized in Parts 1–2 (plus any seeded demo reports) show up.
4. Filter to a combination nothing matches — status = "classified" is a safe choice, since no path in this demo ever leaves a report parked there — to show the empty state. Note that **Export CSV** disappears along with it: the export link only exists when there's something to export.
5. Click **Clear filters** to reset.
6. Click into one of the reports you just finalized.
   - The section title reads "Finalized," and the button says **Save corrections** rather than **Save & finalize report** — finalizing is a one-way transition the backend guards with a 409 if attempted twice, so the UI never shows a button that would just fail.
7. Click **← Back to reports** to return to the table.
8. Point at **Export CSV**: its link target updates live as filters change, so what downloads is exactly the filtered rows on screen — not a fixed dump of the whole table. Click it to show a real file land.

## Part 4: Analytics tab

1. Click the **Analytics** tab — section title "Fleet analytics," with a note underneath: computed from every *finalized* repair/PM report only — drafts and in-review reports aren't counted since their numbers aren't final yet.
2. Three stat tiles up top: **Total labor hours**, **Units replaced** (with a distinct-parts count alongside it), **Repair/PM reports counted**.
3. Below that, four roll-ups, all real server-side aggregation — nothing computed client-side:
   - **Most replaced parts** — one bar per part, merged by part number across every report that used it.
   - **Labor hours by instrument** — one bar per instrument in the fleet, including a "No repair/PM reports yet" case for one that hasn't needed service.
   - **Labor hours by fault category** (repair reports only).
   - **Pass / fail rate** — a three-way stacked bar per report type (pass / fail / not recorded), so a report where the technician never filled in a retest result isn't silently miscounted as a failure.

**Talking point:** this whole tab is one endpoint, `GET /analytics/fleet` — nothing here is precomputed or cached, it's live off whatever's finalized right now, including the two reports you just created in Parts 1 and 2.

## Part 5: Templates tab

This screen replaces "edit a Python literal and re-run a seed script" as the only way to change what fields a report type asks for.

1. Click the **Templates** tab — "Report templates," with the existing calibration/repair/preventive\_maintenance rows and their field counts.
2. Click **+ New template**, fill in a model name.
3. Click **+ Add field** for a plain text field — name it anything.
4. Click **+ Add field** again, switch its type to **enum**, and demonstrate the tag-input: type a value, press Enter, repeat — each becomes a removable chip.
5. Click **Create template** — it lands in the list with the right field count.
6. Click **Edit** on it, add a third field typed **object\[\]** (this is what backs a field like `components_replaced` in Part 2), click **+ Add column** to show the item-schema column builder.
7. Click **Save changes** — the field count updates in place.
8. Click **Delete** — it's a two-step confirm (**Delete**, then **Confirm delete**), with a **Cancel** that's a true no-op, before anything is actually removed.

**Talking point:** every enum/object\[\] field a technician saw on the review screen in Parts 1–2 (`fault_category`, `components_replaced`) is defined here, not hardcoded — this is the same structured editor, not a simplified preview of it.

## Part 6: Instruments tab

Replaces "`POST /instruments` from a script, then edit the row by hand for anything else" as the only way to manage the fleet.

1. Click the **Instruments** tab.
2. Click **+ New instrument** — note the create form has **no Status field** at all: a new instrument is always created active, so there's nothing to set yet.
3. Fill in Name, Model, Serial number, Location → **Create instrument**.
4. It lands in the list with an Active pill.
5. Switch to the **Reports** tab and open the instrument filter dropdown — the new instrument is already there, no reload needed. Call this out explicitly: this tab shares one top-level instrument list with the rest of the app, so a create here shows up in the Reports filter and the instrument detail page immediately.
6. Back on Instruments, click **Edit** on it — now **Status** appears (only an instrument that already exists has a status worth changing). Rename it, change the location, set status to **In maintenance** → **Save changes** — it updates in place, not as a second row.
7. Optional, if there's time: edit a second instrument to reuse the first one's serial number, to show the duplicate-serial conflict surfaces as a real error banner rather than failing silently.

## Part 7: Instrument detail page and the trend chart

**Ahead of time** (see the prep checklist): run `python -m app.seed_trend_demo` once before the demo — it drops 5 synthetic finalized calibration reports on the FACSAria III, two months apart, so this section has a real multi-point line to show instead of the "only one report" fallback.

1. From the **Reports** tab, select **FACSAria III** in the instrument filter, then click **View instrument details** (or open any of its reports and click **View instrument: FACSAria III** from the review screen).
2. Point out the header: instrument name, model/serial in the meta line, its status pill, then two stat tiles — reports on file, most recent activity.
3. Below that, the **Trend** section — the field picker defaults to `baseline_cv_percent`, a per-detector field, rendering as three lines (detector 1/2/3) with a legend, because it's a `number[detector]` field, not a flat number.
4. Hover near the right edge of the chart — a crosshair and tooltip appear with one row per detector for that date.
5. Click **View as table** — the same data, every point readable without hovering, for anyone in the room who wants exact numbers rather than reading a line.
6. Switch the field picker to `fluidics_pressure_psi` — a flat number field, so it collapses to a single line, no legend, with a direct end-value label on the last point.
7. Scroll down to **Report history** — every finalized report for this instrument, in one table, reachable without leaving the page.

**Talking point:** the list of chartable fields isn't hardcoded either — `GET /instruments/{id}/trend-fields` derives it from whatever numeric fields this instrument's own finalized reports actually resolved to, so a new template's numeric fields show up automatically and a never-used field never appears as a dead end.

If someone asks what happens with less data: open a freshly-created instrument's detail page (e.g. one from Part 6) — a single finalized report falls back to a plain "only one report has recorded this so far" message instead of a one-point chart, and zero finalized reports shows "No numeric fields have recorded data yet."

## Behind the scenes: two doc fixes worth mentioning

If someone in the room asks how current the documentation actually is, two small, real fixes landed alongside this demo — worth having ready as a concrete answer rather than a vague "pretty current, probably":

- **A new seeding script**, `python -m app.seed_trend_demo` (the one used in the prep checklist and Part 7 above), was added specifically so the trend chart has realistic multi-point data ready before a live demo, instead of depending on manual uploads or the single-report fallback.
- **The architecture spec, SL-ARCH-001, was refreshed to v0.13.** §7, §9, §11, and §12 had drifted behind the actual build — the Analytics tab, the Templates and Instruments CRUD editors, and the generalized trend chart all shipped with no corresponding spec update — and are now back in sync with what's demoed here.

## Closing: what's next

Keep this short — 3–5 honest, specific things ready for "what's not done yet," not a roadmap pitch.

- **Live Claude is already wired in.** Everything just demoed ran on a deterministic stub for speed and repeatability, but `classify()`/`extract()` already call the real Anthropic API when `USE_LIVE_CLAUDE=true` — there's a separate opt-in smoke test (`tests/e2e-live/`) that verifies this against a real scanned PDF.
- **Production build & deployment isn't done.** The app runs today as a dev server (Vite) against a local Postgres — it isn't packaged for a real deployment target yet.
- **Attachment storage is local disk today**, by deliberate MVP choice — swapping in S3-compatible object storage is a scoped follow-up, not a redesign.
- **No auth or roles yet.** Everything editable in this demo — templates, instruments — has no access control: anyone with the URL can edit a template or retire an instrument.
- **The trend chart shows one field at a time.** Comparing two fields on the same chart isn't supported yet.
- **Full roadmap is documented.** SL-ARCH-001 v0.13 §11 has the fuller phased roadmap — Phase 2 (real auth/roles, a field-level audit trail, report/template versioning, PDF export) and Phase 3 (multi-site scoping, SSO, natural-language queries) — if this list raises more questions than it answers.
