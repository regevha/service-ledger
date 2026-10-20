# ServiceLedger demo script (October 2026)

A presenter's walkthrough of the app as it stands on `main` on 2026-10-19. It replaces `service-ledger-demo-script.md`, which describes an earlier build and is no longer kept up to date.

About 25 minutes for everything. The **10-minute cut** is Parts 1, 2, 3 and 6. Part 2 (the flagged path) is the one to keep whatever else goes.

Everything runs on the deterministic stub reader (no API key, same result every time, works offline). Say so once near the top, so nobody wonders why extraction is instant. Where the live model behaves differently, the part says so.

## Before you start

- **Postgres running** (`pg_ctlcluster 16 main start`, or `service postgresql start`).
- **Backend:** from `backend/`, `uvicorn app.main:app` (port 8000). On start it seeds the fleet and templates. If you have run the app before, run `alembic upgrade head` first.
- **Worker, second terminal:** `python -m app.worker`. Without it, uploads sit at "pending" forever.
- **Frontend:** from `frontend/`, `npm run dev` (port 5173); have `http://localhost:5173` open.
- **Seed data:** `python -m app.seed_demo_reports` (three finalized reports, so the Reports tab is not empty) and `python -m app.seed_trend_demo` (five Aria calibration reports for the trend chart).
- **Files to upload** (in `frontend/tests/e2e/fixtures/`): `confident-scan.pdf` and `sample-work-order.pdf`. **Renaming is not enough.** The app refuses a file whose bytes it has already read (409, "This exact file is already on file"), so every copy needs one different byte at the end. From the fixtures folder:
  ```
  cp sample-work-order.pdf sample-work-order-2.pdf   && printf '\n%%2\n' >> sample-work-order-2.pdf
  cp confident-scan.pdf scan_R647794E6093.pdf        && printf '\n%%3\n' >> scan_R647794E6093.pdf
  cp confident-scan.pdf hebrew-visit.pdf             && printf '\n%%4\n' >> hebrew-visit.pdf
  cp confident-scan.pdf othermaker-ZZ1234.pdf        && printf '\n%%5\n' >> othermaker-ZZ1234.pdf
  echo "just notes" > notes.txt
  ```
  The names matter, because the stub reads them: the serial in `scan_R647794E6093.pdf` (Part 3), "hebrew" in `hebrew-visit.pdf` gets the translation fixture, and "othermaker-" in `othermaker-ZZ1234.pdf` is read as another company's instrument that is not in the fleet (Part 7).
- **Reset between runs.** The instruments and templates you add stay in the database, and a second unit of a model changes how later uploads behave.

The seeded fleet has five instruments: FACSAria III, LSRFortessa, FACSDiscover S8, Cytek Aurora and CytoFLEX S.

## Part 1: The fast path (2 min)

A report that just works. Most uploads land here, and it should be boring.

1. **New report** tab. Type a name in "Your name (optional)".
2. Drop `confident-scan.pdf`, click **Upload & classify**.
3. No manual step appears: the instrument and report type were both above the 85% threshold, so the template is chosen and the field list opens at once.
4. Point at the small badge on every field. Without a key it says "placeholder", and a notice says the values are not read from the document. With a live key it is a per-field confidence ("92% confident"). The report date at the top is read from the document too.
5. **Save & finalize report**, then **Start another report**.

*Say:* "Two calls run in the background, classify and then extract, by a worker, not the browser."

## Part 2: The flagged path, the centerpiece (4 min)

A real ambiguity, handled honestly instead of guessed past.

1. Upload `sample-work-order.pdf`, **Upload & classify**.
2. Before extraction, rows appear: the model and serial the document shows (each with a badge), the **Instrument** it resolves to, and the **Report type**. The report type has an amber badge.
3. *Say:* "Repair, preventive maintenance and calibration look almost the same on this vendor's forms, so the system says it is unsure instead of picking silently."
4. **Confirm & continue**. (The same button lets you override a confident wrong guess.)
5. On the review screen: **fault category** is filled from the text, **work performed** is a full paragraph, and **root cause** is blank with a highlighted "pending" state. It is not on the document, and the model declined to invent it.
6. Type a root cause yourself, then **Save & finalize report**.

*Land this:* the badges and the pending highlight are the trust boundary. A lab manager only re-checks the two or three fields the system flags.

## Part 3: Upload checks and serial matching (3 min)

1. Upload `notes.txt`. A red banner says "Unsupported file type. Upload a PDF or a PNG, JPEG, GIF or WebP image." The type comes from the file's first bytes, not its name. Limits are 20 MB for a PDF and 5 MB for an image. Click **Try again**.
2. **Instruments** → **+ New instrument**: name "LSRFortessa Annex", model LSRFortessa, serial `R647794E6093`, manufacturer BD → **Create instrument**. There are now two LSRFortessas.
3. Upload `sample-work-order.pdf` again: it is refused, "This exact file is already on file and has been read" (a good moment to say the app never reads the same bytes twice). Now upload `sample-work-order-2.pdf`, the same form with one byte changed. The instrument row says **Select instrument…** and **Confirm & continue** stays disabled until you choose. *Say:* "The model alone no longer says which machine, so it will not guess."
4. Start another report and upload `scan_R647794E6093.pdf`. It goes straight to review with a blue banner: "Matched to LSRFortessa (R647794E6093) by the serial number on the document."
5. Finalize it. You will find it under the Annex unit in Part 4.

*Say:* "Serials are compared ignoring case and punctuation. A serial that belongs to a different model is flagged as a conflict, never auto-resolved."

## Part 4: Finding reports (4 min)

1. **Reports** tab. Click column headers to sort (instrument, type, lab manager, report date, status); a second click reverses, a third clears. Open a report and come back: the sort stays.
2. Filters: instrument, report type, status, from/to dates, lab manager. They all narrow together. Pick the Annex instrument to show the report from Part 3.
3. **Search report text**: type a word from a finalized report (for example "valve" or a part name). Results come best match first, with an excerpt, and the matched words are highlighted when you open the report. Say that search covers **finalized reports only**: choosing another status with a search shows a message, not a silent empty list.
4. **Save this filter**: set a combination (or just a search word), click **Save this filter**, give it a name. The picker shows "1 of 5". Clear the filters, pick the saved one, and everything comes back. Mention the limit of five and that a filter whose instrument was deleted is marked as stale.
5. Open a finalized report: the button is **Save corrections**, not "Save & finalize". **Download PDF** produces a formatted report. Back on the list, **Export CSV** exports exactly the filtered rows on screen.

## Part 5: Analytics (3 min)

1. **Analytics** tab. The note says only finalized repair and preventive maintenance reports are counted, and a line shows "Based on N finalized reports".
2. Stat tiles: total labor hours, units replaced, reports counted. Below: most replaced parts, labor hours by instrument, labor hours by fault category, pass/fail rate.
3. **Filters on top** apply to the whole page: manufacturer, instrument, report type, from/to dates. Pick a manufacturer: the instrument list narrows to that maker's units and the basis line updates. Enter a "from" date after the "to" date to show the explanation.
4. **Same-model comparison**: for a model with several units, the units side by side. Open an instrument (Reports → **View instrument details**, FACSAria III) for the **Trend** chart: `baseline_cv_percent` as three detector lines with a tooltip, **View as table**, and the `fluidics_pressure_psi` single line. The list of chartable fields comes from the data, not a fixed list.

## Part 6: Templates, and comparing them (5 min)

**Templates** tab. A template is the instruction set sent to the model at extraction, and it drives the review screen, the PDF and Analytics.

1. Show the list: one row per report type and model, with a field count.
2. **+ New template**. Use **Start from** to copy the closest existing template; add a field of type **enum** (type a value, press Enter for each choice) and one **object[]** with **+ Add column**. **Create template**, then **Delete** (two steps, with a true Cancel).
3. **Compare templates** (or a row's **Compare** action). Choose *Malfunction / repair · (any model)* and *Malfunction / repair · CytoFLEX S*. The summary says "7 of 10 fields shared". Fields only on one side are marked, and the differing words are highlighted. Tick **Show only the differences**.
   - *Say:* "This is advice for a person. Nothing is merged or renamed. Only templates of the same instrument type can be compared."
4. **Field aliases**: open the screen and show the two seeded groups (for example *Result of the check after the work*: `retest_result`, `verification_result`). Compare a template that uses one name with a template that uses the other: they appear as a dashed **Possible match** with both names and the differences. Say that aliases are used only by the comparison, never by extraction or Analytics, and that a name can be in one group only.
5. Optional: **+ New group**, add two names, **Create group**. It needs at least two names.

## Part 7: Foreign forms and Hebrew documents (4 min)

1. **Another company's form.** Upload `othermaker-ZZ1234.pdf`. The confirm screen says "<maker> <model> (not in your fleet)" and offers a pre-filled add-instrument panel. Check the name and the **Kind of instrument** (it can default to the wrong kind: set it to Flow cytometer), click **Add instrument & classify again**, and the document is classified again and matched by serial.
2. **No template for the model.** If the new instrument's report type has only the generic template, the review screen shows a notice (*Create a <model> template* / *Not now*). The button opens the Templates tab with **Start from** set to the closest template. Save it and you return to the waiting report, which is read again with the new template. *Say:* "It suggests the closest existing template; a person still decides."
3. **Hebrew.** Upload `hebrew-visit.pdf`. The review screen shows the original beside an editable English translation. Point out:
   - the **ignored pages** (the daily QC printouts, here pages 2 and 3), with **Include page 2** if wanted;
   - the **identifier check**: serials, order numbers and part numbers in the original must appear in the English;
   - **durations** such as 01:25 shown as decimal hours (1.42 h).
   Edit the English and click **Accept my edits & continue** (or **Discard and use the original**). Classification runs only on the accepted English.
   - *Say:* "Review is always required for Hebrew. The English is shown on screen only and is not offered as a download."

Without a key a Hebrew text layer is refused with a clear message; the stub serves a fixed translation for file names containing "hebrew". With a live key the translation is real.

## Part 8: Instruments (2 min)

1. **Instruments** tab → **+ New instrument**. There is no Status field on create. Choose or add an **instrument type** (**+ Add a type**); the type decides which templates apply.
2. Fill in name, model, serial, manufacturer, an optional **distributor**, and room name.
3. **Edit** it: now Status appears. Set **In maintenance** and save; it updates in place. A duplicate serial shows a real error banner.
4. The new instrument is already in the Reports and Analytics filters without a reload.

## What to say about trust and limits

- **What is real today:** upload checks, task-code typing (T113 repair, T111 preventive maintenance, T107 installation/upgrade), serial and model matching, duplicate warnings (same bytes or same work order, warn only), search, saved filters, sorting, Analytics, template management and comparison, translation review.
- **Live model:** classification and extraction call the API when `USE_LIVE_CLAUDE=true`. It has been run end to end on every supplied sample document (six English reports and two Hebrew ones). One known intermittent miss: free text such as `service_description` can keep a wrong serial from the Subject line. Hebrew output varies between runs, which is why review is required.
- **Not done yet:** sign-in and roles (anyone with the URL can edit templates and instruments; the work is parked on purpose), a production build and deployment (it runs as a dev server on a local Postgres), object storage for attachments (local disk today), HEIC photos, and cross-type template comparison or an export of the comparison.
- **Fallback if a live run goes wrong:** the static pages in `docs/` (`new-report-demo.html`, `pm-review-demo.html`, `repair-review-demo.html`, `instrument-timeline-demo.html`) show the main screens with sample data and need no server. They predate search, saved filters, translation review and template comparison.
