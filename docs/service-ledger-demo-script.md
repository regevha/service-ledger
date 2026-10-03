# ServiceLedger Demo Script

> This is a checked-in copy of the live, editable version at
> https://claude.ai/artifact/1uJXpdK14FtV4pS6rAJkc1 — edit that one and
> re-export here rather than editing this file directly, so the two don't
> drift apart.

A presenter's walkthrough for showing off the app end to end — what to click, what to say, and why it matters. Roughly 30 minutes for the full run; Parts 1–3 alone make a tight 10-minute version, with Part 2 as the one part worth keeping no matter what gets cut.

Everything below runs against the deterministic stub classifier/extractor (no `ANTHROPIC_API_KEY` needed) — same result every time, safe to demo offline.

**No backend to hand?** A static demo page with sample data (no server, nothing uploaded) covers the same screens, including the upload checks and serial matching: https://claude.ai/artifact/9dLVUsPL8vmB3wTrz7UeVU. It is a private page, so open it from the account that owns it or share it first. It is the safest fallback if a live run goes wrong.

## Before you start: prep checklist

Everything in this walkthrough runs against a deterministic stub classifier/extractor (`USE_LIVE_CLAUDE=false`, the default), not the live Claude API — same code path, same UI, but free and exactly repeatable. Say this once, near the top, so no one wonders why extraction is instant or thinks the values are made up on the spot.

- **Postgres running** (`service postgresql start` if it isn't — nothing else works without it).
- **Backend running:** `uvicorn app.main:app --reload` (port 8000).
- **Worker running, in a second terminal:** `python -m app.worker`. Without this, "Upload & classify" and extraction enqueue a job and sit at `pending` forever — nothing else calls `classify()`/`extract()`.
- **Frontend running:** `npm run dev` (Vite, port 5173) — have `http://localhost:5173` already open in a browser tab.
- **Fleet + templates seeded** (idempotent, safe to re-run): `python -m app.seed_instruments && python -m app.seed_templates`.
- **Trend chart data seeded ahead of time**, so Part 8 doesn't depend on live uploads mid-demo: `python -m app.seed_trend_demo` — 5 synthetic FACSAria III calibration reports, two months apart.
- **Optional:** `python -m app.seed_demo_reports` — 3 more finalized reports (real extraction results) so the Reports tab isn't showing only what you upload live.
- **Two fixture files ready to upload**, both already in the repo at `frontend/tests/e2e/fixtures/`: `confident-scan.pdf` (Part 1) and `sample-work-order.pdf` (Part 2 — the centerpiece).
- **Two more files for Part 3**, made from the first: a copy of `confident-scan.pdf` renamed `scan_R647794E6093.pdf`, and any text file (e.g. `notes.txt`). In stub mode the "reader" finds a serial number when the uploaded file's *name* contains one (the real app reads it off the page), so renaming the file is how you choose what the scan "says."
- **Reset before a run** if you've demoed before: the instrument added in Part 3 (and edited in Part 7) stays in the database, and a second unit of a model changes how the later uploads behave.

## Part 1: New report, the fast path

This is the report that "just works" — most real uploads land here, and that's the point: it should be boring.

1. Click the **New report** tab (already selected on a fresh load).
2. Type a name into **"Your name (optional)"**.
3. Drop **`confident-scan.pdf`** onto the dropzone (or use the file picker). The dropzone says what it takes: a PDF or a PNG, JPEG, GIF or WebP image.
4. Click **Upload & classify**.
   - *Say while it runs:* "That kicked off two real backend calls — `classify()`, then `extract()` — both run by the background worker, not the browser."
5. No manual-confirm row appears — both the instrument guess and the report-type guess cleared the 85% classification threshold, so the app resolves the template on its own and jumps straight to the field list.
6. Point out the **field list**: every field has its own small percentage badge ("X% confident") — a per-field *extraction* confidence, distinct from the whole-document *classification* confidence you'll see in Part 2. The **Report date** field at the top is read from the document by the same call (the date of the visit, not a date the technician types), and carries its own badge.
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

## Part 3: Upload checks and serial matching

Two things that keep the pipeline honest *before* a model is ever asked: refusing files it can't read, and using the serial number on the page to pick the right physical instrument when a model has more than one unit.

**Upload checks (about a minute)**

1. Click **New report**, and choose **`notes.txt`** → **Upload & classify**.
2. A red banner says "Unsupported file type. Upload a PDF or a PNG, JPEG, GIF or WebP image." — click **Try again**.
   - *Say:* "The type comes from the file's own first bytes, not its name or what the browser claims, so a renamed text file can't get through, and a scan that's really a PNG but named `.pdf` is handled as the image it is. Size limits are 20 MB for a PDF and 5 MB for an image, and the message says how big the file was and what the limit is. HEIC phone photos aren't accepted — export JPEG or PNG."

**Serial matching (about three minutes)**

3. Go to **Instruments** → **+ New instrument**: name "LSRFortessa — Annex", model **LSRFortessa**, serial **`R647794E6093`** → **Create instrument**. The fleet now has two LSRFortessas.
4. Back on **New report**, upload **`sample-work-order.pdf`** again and click **Upload & classify**.
   - The instrument row now shows **Select instrument…** instead of a pre-selected unit, and **Confirm & continue** stays disabled until you choose one.
   - *Say:* "Same document as Part 2, but the model alone no longer says which machine this is — there are two. The system won't pick one for you. Before serial matching it silently chose whichever sorted first."
   - Choose a unit and continue (or just move on; you don't need to finalize this one).
5. Start another report and upload **`scan_R647794E6093.pdf`**.
6. It goes straight to the review screen with a blue banner: "Matched to LSRFortessa (R647794E6093) by the serial number on the document." No manual step, even though the model has two units.
   - *Say:* "Classification now reads the printed serial number as well, normalizes it — case and punctuation don't matter — and matches it to the fleet. A confident match picks the unit. If the serial matches a machine of a *different* model than the form says, it's flagged as a conflict and never auto-resolved. If the serial isn't in the fleet, or was read with low confidence, it falls back to the old rule: one unit of the model is chosen for you, several leave the choice to you — and the banner tells you which happened."
7. Finalize, then open **Reports** and filter by that instrument to show the report belongs to the Annex unit, not the original.

**Talking point:** this is why the fleet table only enforces a unique *serial number*, not a unique model — real labs have several units of one model, and a report attributed to the wrong one corrupts that instrument's history and its trend chart.

## Part 4: Reports tab

1. Click the **Reports** tab.
2. Point out the filter row: instrument, report type, status, a from/to date range, and a technician name (a partial, case-insensitive match as you type) — they all combine (every filter narrows the result, not an either/or).
3. Filter by report type or status to something that matches — the reports finalized in Parts 1–3 (plus any seeded demo reports) show up. Try the technician box with the name you typed in Part 1.
4. Filter to a combination nothing matches — status = "classified" is a safe choice, since no path in this demo ever leaves a report parked there — to show the empty state. Note that **Export CSV** disappears along with it: the export link only exists when there's something to export.
5. Click **Clear filters** to reset.
6. Click into one of the reports you just finalized.
   - The section title reads "Finalized," and the button says **Save corrections** rather than **Save & finalize report** — finalizing is a one-way transition the backend guards with a 409 if attempted twice, so the UI never shows a button that would just fail.
   - Click **Download PDF** — a formatted single-report PDF generated from the same field layout as the review screen. Open it to show a real file.
7. Click **← Back to reports** to return to the table.
8. Point at **Export CSV**: its link target updates live as filters change, so what downloads is exactly the filtered rows on screen — not a fixed dump of the whole table. Click it to show a real file land.

## Part 5: Analytics tab

1. Click the **Analytics** tab — section title "Fleet analytics," with a note underneath: computed from every *finalized* repair/PM report only — drafts and in-review reports aren't counted since their numbers aren't final yet.
2. Three stat tiles up top: **Total labor hours**, **Units replaced** (with a distinct-parts count alongside it), **Repair/PM reports counted**.
3. Below that, four roll-ups, all real server-side aggregation — nothing computed client-side:
   - **Most replaced parts** — one bar per part, merged by part number across every report that used it.
   - **Labor hours by instrument** — one bar per instrument in the fleet, including a "No repair/PM reports yet" case for one that hasn't needed service.
   - **Labor hours by fault category** (repair reports only).
   - **Pass / fail rate** — a three-way stacked bar per report type (pass / fail / not recorded), so a report where the technician never filled in a retest result isn't silently miscounted as a failure.

**Talking point:** this whole tab is one endpoint, `GET /analytics/fleet` — nothing here is precomputed or cached, it's live off whatever's finalized right now, including the reports you just created in Parts 1–3.

## Part 6: Templates tab

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

## Part 7: Instruments tab

Replaces "`POST /instruments` from a script, then edit the row by hand for anything else" as the only way to manage the fleet.

1. Click the **Instruments** tab.
2. Click **+ New instrument** (or point at the one you created in Part 3) — note the create form has **no Status field** at all: a new instrument is always created active, so there's nothing to set yet.
3. Fill in Name, Model, Serial number, Location → **Create instrument**.
4. It lands in the list with an Active pill.
5. Switch to the **Reports** tab and open the instrument filter dropdown — the new instrument is already there, no reload needed. Call this out explicitly: this tab shares one top-level instrument list with the rest of the app, so a create here shows up in the Reports filter and the instrument detail page immediately.
6. Back on Instruments, click **Edit** on it — now **Status** appears (only an instrument that already exists has a status worth changing). Rename it, change the location, set status to **In maintenance** → **Save changes** — it updates in place, not as a second row.
7. Optional, if there's time: edit a second instrument to reuse the first one's serial number, to show the duplicate-serial conflict surfaces as a real error banner rather than failing silently.

## Part 8: Instrument detail page and the trend chart

**Ahead of time** (see the prep checklist): run `python -m app.seed_trend_demo` once before the demo — it drops 5 synthetic finalized calibration reports on the FACSAria III, two months apart, so this section has a real multi-point line to show instead of the "only one report" fallback.

1. From the **Reports** tab, select **FACSAria III** in the instrument filter, then click **View instrument details** (or open any of its reports and click **View instrument: FACSAria III** from the review screen).
2. Point out the header: instrument name, model/serial in the meta line, its status pill, then two stat tiles — reports on file, most recent activity.
3. Below that, the **Trend** section — the field picker defaults to `baseline_cv_percent`, a per-detector field, rendering as three lines (detector 1/2/3) with a legend, because it's a `number[detector]` field, not a flat number.
4. Hover near the right edge of the chart — a crosshair and tooltip appear with one row per detector for that date.
5. Click **View as table** — the same data, every point readable without hovering, for anyone in the room who wants exact numbers rather than reading a line.
6. Switch the field picker to `fluidics_pressure_psi` — a flat number field, so it collapses to a single line, no legend, with a direct end-value label on the last point.
7. Scroll down to **Report history** — every finalized report for this instrument, in one table, reachable without leaving the page.

**Talking point:** the list of chartable fields isn't hardcoded either — `GET /instruments/{id}/trend-fields` derives it from whatever numeric fields this instrument's own finalized reports actually resolved to, so a new template's numeric fields show up automatically and a never-used field never appears as a dead end.

If someone asks what happens with less data: open a freshly-created instrument's detail page (e.g. one from Part 7) — a single finalized report falls back to a plain "only one report has recorded this so far" message instead of a one-point chart, and zero finalized reports shows "No numeric fields have recorded data yet."

## Behind the scenes: how current the docs and tests are

If someone in the room asks how current the documentation and testing actually are, these are concrete answers rather than a vague "pretty current, probably":

- **The architecture spec, SL-ARCH-001, is at v0.16, and the technical design doc (SL-TDD-001) at v0.4.** The latest round corrected places where the spec had described a plan rather than the build — for example, there is no "preprocess" step (Claude reads the PDF or image directly; the only step before the model is the upload check), and extraction returns flat fields with a confidence each, not per-field snippets — and added serial matching, image scans and upload validation.
- **Backend: 205 tests against a real Postgres database, about 97% line-and-branch coverage** (`pytest --cov`; the demo seed scripts and the e2e reset helper are deliberately left out, and the run fails below 95%). That includes tests that force the "two requests collide" race branches through the database's own unique indexes and foreign keys, not mocks.
- **Frontend: 27 Playwright browser specs driving the real UI**, with about 91% of lines and 76% of branches reached (`npm run test:e2e:coverage`). There are no frontend unit tests.
- **A new seeding script**, `python -m app.seed_trend_demo` (used in the prep checklist and Part 8), exists specifically so the trend chart has realistic multi-point data before a live demo.

## Closing: what's next

Keep this short — 3–5 honest, specific things ready for "what's not done yet," not a roadmap pitch.

- **Live Claude is already wired in.** Everything just demoed ran on a deterministic stub for speed and repeatability, but `classify()`/`extract()` already call the real Anthropic API when `USE_LIVE_CLAUDE=true` — there's a separate opt-in smoke test (`tests/e2e-live/`) for running it against a real scanned PDF. Be straight about the limit: the request and response handling is covered by tests, and a real FACSDiscover S8 report was transcribed by hand to check the S8 template fits, but the live call hasn't been run on that report in this build yet.
- **Production build & deployment isn't done.** The app runs today as a dev server (Vite) against a local Postgres — it isn't packaged for a real deployment target yet.
- **Attachment storage is local disk today**, by deliberate MVP choice — swapping in S3-compatible object storage is a scoped follow-up, not a redesign.
- **HEIC photos aren't accepted** (the model API doesn't take them) — scans must be PDF, PNG, JPEG, GIF or WebP, and PDF page count isn't checked.
- **No auth or roles yet.** Everything editable in this demo — templates, instruments — has no access control: anyone with the URL can edit a template or retire an instrument.
- **The trend chart shows one field at a time.** Comparing two fields on the same chart isn't supported yet.
- **Full roadmap is documented.** SL-ARCH-001 v0.16 §11 has the fuller phased roadmap — Phase 2 (real auth/roles, a field-level audit trail, report/template versioning; per-report PDF export has already shipped) and Phase 3 (multi-site scoping, SSO, natural-language queries) — if this list raises more questions than it answers.
