# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Regenerating API types from the backend

`src/api.ts` derives its six backend-enum types (`InstrumentStatus`,
`ReportType`, `ReportStatus`, `ExtractionJobStatus`, `ExtractionJobKind`,
`FieldType`) from `src/generated/api-schema.ts` rather than hand-typing
them — that file is generated from the backend's own OpenAPI schema, so it
can't silently drift from `backend/app/models.py`'s real enum classes (or,
for `FieldType`, `backend/app/schemas.py::TemplateFieldType`) the way a
hand-copied union type could. `FieldType` used to be the one exception here
— hand-typed because no backend enum existed for it — until template
management gave it a real one to derive from; every shared enum is now
sourced from the backend. `src/generated/api-schema.ts` is committed (so a
build never needs Python or a backend checkout); regenerate it after
changing a backend enum or any response shape those six types touch:

```bash
# 1. From backend/, with its venv active — no running server or database
#    needed, this only imports the already-defined FastAPI app object:
python -m scripts.export_openapi > ../frontend/openapi.json

# 2. From frontend/ — turns that schema into real TypeScript types:
npm run codegen
```

The other hand-written interfaces in `api.ts` (`Instrument`, `Report`,
`ReportTemplate`, ...) are left alone on purpose — they're small, stable, and
more readable authored directly than as a deep generated-schema lookup; only
the enums, where backend/frontend drift is easy and silent, are sourced from
the generated file.

## End-to-end tests (Playwright)

`tests/e2e/` covers the flows a screen-by-screen manual pass would otherwise
have to re-check before every milestone: the confident upload→classify→
extract→review→finalize happy path, the uncertain-report-type manual-confirm
detour, the reports search/filter screen (including the empty state, the
debounced lab manager free-text filter's case-insensitive partial match, and
editing an already-finalized report), CSV export, the per-report PDF
download (present once a template's resolved, absent otherwise), the FieldEditor's
array-shaped controls (per-detector number maps, object-array tables), the
Analytics tab's fleet-wide roll-ups, the Templates tab's structured field
editor (create → edit → delete, including the enum-options tag-input and
the object[] item_schema column builder), the instrument detail page's
report history and its nav stack (a report opened from an instrument page
returns to that page, not the top-level list), its trend chart (the field
picker, a `number[detector]` field's multi-series legend/hover/table, a
flat `number` field's single series, and the single-report/no-data
fallbacks), the Instruments tab's create → edit cycle (including that a
save there shows up immediately in the Reports tab's instrument filter, and
that a duplicate-serial-number conflict surfaces as a real error banner),
serial-number matching when several fleet units share a model (classification
resolving to the one whose serial the document actually names, see
`serial-matching.spec.ts`), the extracted service date shown on review and
correctable before finalize (`service-date.spec.ts`), the persistent duplicate banner on a saved report (same work order on
the same instrument; not on another unit — `saved-duplicates.spec.ts`, whose
test PDFs come from `text-pdf.ts` so the backend reads a real text layer), and the app's error
states (an unreachable backend, a failed classification call).

### Instrument detail page

Reached from the Reports tab — pick an instrument in the filter row, then
"View instrument details", or open any report and follow its "View
instrument: ..." link. Shows the instrument's own metadata, two stat tiles
(report count / most recent activity), and its full report history via the
existing `GET /reports?instrument_id=` filter — no new backend endpoint
needed, since the fleet is small enough (§1: a fixed 3-instrument list, at
least until the Instruments tab below lets it grow) to already be fully
loaded by `App`'s own `useEffect` and looked up by id client-side.

### Templates tab

`TemplateManager.tsx` is the structured editor for report templates. Beyond
create/edit/delete it:

* **Says what is wrong.** `templateProblems()` lists, as you type, what blocks
  a save — no fields, a blank or repeated field name (case-insensitive), a
  choice field with no options, a table field with no columns — instead of a
  silently greyed-out button. Only rules the client cannot know (a reserved
  name like `report_date`, a model/type collision) come back from the backend.
* **Duplicates.** *Duplicate* opens a new template pre-filled with another's
  fields and a blank model (each type + model can have one template, so the
  copy needs a different model; saving a clash shows the backend's 409).
* **Suggests models** from the fleet (`<datalist>` fed by the instruments list).
* **Shows usage.** A *Reports* column (from `GET /report-templates/usage`:
  reports using the template, and how many are finalized). A template reports
  use has its *Delete* disabled with the reason; if a report attaches in the
  moment between loading the list and confirming, the backend's 409 is shown.
* **Warns before dropping fields.** Editing a template in use shows how many
  reports use it; saving after removing or renaming a field asks first,
  naming the fields (the stored values are kept, the fields just stop
  appearing on those reports). Adding fields needs no confirmation.

Covered by `template-management.spec.ts` (create → edit → delete) and
`template-manager-improvements.spec.ts` (the above, plus field reorder/remove/
retype, table-column rename rules, and the usage/list load failures).

### Instruments tab

`InstrumentManager.tsx` — create/edit for the fleet, replacing "`POST
/instruments` from a script or curl, then edit the row in the DB by hand for
anything else" as the only way to add an instrument or fix a typo'd serial
number, rename, relocate, or retire one. A standalone tab (rather than
folding create/edit into the instrument detail page above) now that there's
somewhere to anchor a fleet-wide list, following the same list/create/edit
`ManagerMode` pattern as the Templates tab.

Unlike `TemplateManagerScreen` (its own independent fetch, since nothing
else needs the template list), the instrument list is already loaded once
at the top of `App.tsx` and threaded down to the Reports filter and the
instrument detail page — so `InstrumentManagerScreen` takes that same
`instruments` array and a `refresh` callback as props instead of keeping a
second copy, and a create/edit here is reflected in the Reports filter and
instrument detail page immediately, not just after a reload.

Every field but `instrument_type` is editable via the backend's new `PATCH
/instruments/{id}` (the type is picked at creation, see Instrument type
below). On create the Name, Model, Serial number and Manufacturer must all be filled in
(the Create button stays disabled otherwise, and the API refuses blanks too);
Room name is optional. A new
instrument is always created active; status only becomes something to
change once it already exists, so the create form has no Status field at
all, only the edit form does.

**Manufacturer** is free text (the fleet is no longer BD-only), required
when an instrument is created: a column in the list, a field on the
create/edit form (an existing instrument's can still be cleared), and a prefix on the instrument detail page's header line.
It is deliberately not added to the model pickers (intake, Reports filter) or
to the Analytics model comparison: those key on the model name, which already
identifies a unit, and changing their option text would only churn labels.
Covered by `instrument-manufacturer.spec.ts`.

**Instrument type** is a managed list (`GET/POST /instrument-types`) seeded with
Flow cytometer, Electron microscope, ImageStream, Mass spectrometer and PCR
machine. It is chosen when an instrument or a
template is created and cannot be changed afterwards; the create form has an
"+ Add a type" button. A report is matched to a template of its instrument's
own type, and when that type has no template for the report the intake screen
says so and points to the Templates tab. Covered by `instrument-types.spec.ts`.

### Trend chart

The real, generalized version of `docs/instrument-timeline-demo.html`'s
hardcoded per-detector calibration-drift mockup — a follow-up to the
instrument detail page above, once `GET /instruments/{id}/trend` grew
support for `number[detector]`/`number[laser]` map fields (it originally
only supported flat single-number fields, explicitly filtering out dict
values).

`GET /instruments/{id}/trend-fields` (new) drives the field picker — it
derives the list from the real templates the instrument's own finalized
reports actually resolved to (via each report's `template.field_schema`),
so a technically-chartable-but-never-used field never appears as a dead
end, and a new template's numeric fields show up automatically. Picking a
field calls the widened `GET .../trend?field=...`, and `InstrumentTrendChart.tsx`
renders the result as a hand-rolled SVG line chart (no charting library —
consistent with `AnalyticsScreen.tsx`'s own hand-rolled bars), following the
dataviz skill's procedure: one series per `number[detector]`/`number[laser]`
key (or a single series for a flat `number` field) in the app's fixed
`--series-1..5` categorical order, a legend whenever there are ≥ 2 series, a
hover crosshair with a one-tooltip-per-date readout, and a table-view
toggle so every value stays reachable without hovering. A field with fewer
than two data points falls back to a plain "only one report has recorded
this so far" message instead of a one-point chart.

```bash
npm run test:e2e       # headless run
npm run test:e2e:ui    # Playwright's interactive UI mode
npm run test:e2e:coverage  # same suite, instrumented; prints a coverage table, writes coverage/index.html
```

`playwright.config.ts` boots its own backend (stub-mode — `USE_LIVE_CLAUDE=false`,
so this never spends a real API call), its own instance of the background
worker (`app/worker.py`, §3 — classify/extract only enqueue a job now, so
nothing in this suite would ever leave "pending" without one running), and
its own Vite dev server, all on dedicated ports (8001 / 5174 for the
backend/frontend — the worker has no port of its own), so it never touches
the ports a developer might already have running for manual testing
(8000 / 5173) and never runs against real Claude. It truncates its database
before every run via `backend/app/testing/reset_db.py`, then relies on
`app.main`'s own startup hook to reseed the instrument fleet and report
templates — see that router's docstring for why this is a *separate*
database from `backend/tests/conftest.py`'s `service_ledger_test`.

**One-time setup**: this suite needs its own Postgres database
(`service_ledger_e2e`), owned by the same role the backend already uses,
created once per environment — it isn't provisioned automatically because
the app's own DB role doesn't have `CREATEDB`:

```bash
sudo -u postgres createdb service_ledger_e2e
sudo -u postgres psql -c "ALTER DATABASE service_ledger_e2e OWNER TO service_ledger;"
```

### Live-Claude smoke test (real API, opt-in)

`tests/e2e-live/live-claude-smoke.spec.ts` runs the same upload→classify→
extract→review→finalize flow against the *real* Claude API instead of the
stub — useful for sanity-checking that path still works end to end, since
nothing in `tests/e2e/` exercises it (that suite's fixtures and assertions
are stub-specific — see the comments in `playwright.config.ts`). It's opt-in
by construction: a separate config (`playwright.live.config.ts`) with its
own `testDir`, so `npm run test:e2e` never touches it and never needs a real
API key to run.

Needs two things in the environment, neither committed here:

- `ANTHROPIC_API_KEY` — the config throws immediately if it's missing.
- `LIVE_SMOKE_FIXTURE_PATH` — an absolute path to a real scanned service
  report PDF. Never committed to this repo (same reason
  `backend/app/seed_demo_reports.py` never commits the real PDFs its own
  demo data came from: these are real third-party service records). The
  spec skips cleanly, rather than failing, if this isn't set to a file that
  exists.

```bash
ANTHROPIC_API_KEY=sk-ant-... LIVE_SMOKE_FIXTURE_PATH=/path/to/a/real/scan.pdf \
  npx playwright test --config=playwright.live.config.ts
```

Costs two real API calls (one classify, one extract) per run. Assertions
are deliberately loose compared to the stub suite — a live model's exact
wording/confidence can vary slightly from run to run — so this checks for
the absence of errors and that the report was routed to a
report-type-specific field, not byte-for-byte field values.

### Coverage

`npm run test:e2e:coverage` runs the whole suite against a build instrumented
with Istanbul (`vite-plugin-istanbul`, switched on by `COVERAGE=1` in
`vite.config.ts`, so normal runs are untouched). `tests/e2e/coverage.ts` — the
`test` every spec imports — saves each page's `window.__coverage__` after each
test, and `nyc report` merges them (settings in `.nycrc.json`: every file under
`src/` counts, generated types and `main.tsx` do not). The run fails below 88%
lines or 70% branches, and CI runs this command, so a coverage drop fails the
build; raise those numbers in `package.json` when coverage improves. This measures what the browser specs reach; there are no unit tests.
