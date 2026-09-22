import { test, expect, type APIRequestContext } from '@playwright/test';
import { BACKEND_PORT } from '../../playwright.config';

// FieldEditor.tsx renders one interactive control per field_schema type
// (§5), but until now no e2e spec ever touched the array/map controls'
// actual interactivity: happy-path.spec.ts reaches the review screen and
// finalizes without editing a single field, and manual-confirm.spec.ts only
// ever fills a plain <textarea>. EnumArrayInput's add/remove-tag buttons,
// ObjectArrayInput's add/remove-row buttons, and NumberMapInput's
// add/remove-key buttons have never been driven by a test — a regression in
// any of them (e.g. "+ Add row" silently doing nothing) would ship
// undetected. This file exercises the two array-shaped controls used by the
// seeded templates: NumberMapInput (calibration's per-detector fields) and
// ObjectArrayInput (repair's components_replaced table).
//
// Report rows are seeded directly against the API and forced to a known
// template via PATCH .../template, the same pattern reports-search.spec.ts
// uses — this suite has no per-test truncation, so a fresh unique technician
// marker identifies each seeded row regardless of what other specs left
// behind, and forcing the template deterministically avoids depending on
// _stub_classify's file-path hash (§4), which is not controllable from here.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

async function seedReport(
  request: APIRequestContext,
  opts: { model: string; reportType: string; technician: string }
): Promise<{ reportId: string; extractedFields: Record<string, unknown> }> {
  const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: opts.technician } })).json();

  const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
  const instrument = instruments.find((i: { model: string }) => i.model === opts.model);
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: opts.reportType, model: opts.model } })
  ).json();
  const template = templates[0];

  await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: instrument.id, template_id: template.id },
  });

  const attachment = await (
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 seed') } },
    })
  ).json();
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  await waitForJob(request, job.id);

  const extracted = await (await request.get(`${API_BASE}/reports/${report.id}`)).json();
  return { reportId: report.id as string, extractedFields: extracted.extracted_fields };
}

async function waitForJob(request: APIRequestContext, jobId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await (await request.get(`${API_BASE}/extraction-jobs/${jobId}`)).json();
    if (job.status === 'succeeded' || job.status === 'failed') return;
    if (Date.now() >= deadline) throw new Error(`extraction job ${jobId} did not finish within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function openReport(page: import('@playwright/test').Page, marker: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table');
  await page.click(`.report-row-body:has-text("${marker}")`);
  await expect(page.locator('.field-list')).toBeVisible({ timeout: 15_000 });
}

test('editing a number[detector] field (per-detector add/edit/remove) persists through Save corrections', async ({
  page,
  request,
}) => {
  const marker = `E2E-NumberMap-${Date.now()}`;
  const { reportId, extractedFields } = await seedReport(request, {
    model: 'LSRFortessa',
    reportType: 'calibration',
    technician: marker,
  });
  // The stub always fills exactly 3 detectors for a number[detector] field
  // (§4's _stub_value) — asserted here so the edits below are known to be
  // starting from a non-empty map, not accidentally exercising the "no
  // per-detector values yet" empty state instead of the real controls.
  expect(Object.keys(extractedFields.baseline_cv_percent as object)).toHaveLength(3);

  await openReport(page, marker);

  const field = page.locator('.field', { hasText: 'baseline cv percent' });
  await expect(field.locator('.number-map-row')).toHaveCount(3);

  // Edit an existing detector's value.
  await field.locator('.number-map-row', { hasText: 'detector_1' }).locator('input[type="number"]').fill('9.99');

  // Remove a detector entirely.
  await field.locator('.number-map-row', { hasText: 'detector_3' }).locator('button:has-text("Remove")').click();
  await expect(field.locator('.number-map-row')).toHaveCount(2);

  // Add a brand new key via the "+ Add" control (NumberMapInput.addKey — the
  // one path in this component never exercised by any test before now).
  await field.locator('button:has-text("+ Add")').click();
  await expect(field.locator('.number-map-row')).toHaveCount(3);
  await expect(field.locator('.number-map-row', { hasText: 'item_1' })).toBeVisible();

  await page.click('button:has-text("Save corrections")');
  await expect(page.locator('.working-panel')).toHaveCount(0, { timeout: 15_000 });

  const saved = await (await request.get(`${API_BASE}/reports/${reportId}`)).json();
  const savedMap = saved.extracted_fields.baseline_cv_percent as Record<string, number>;
  expect(savedMap.detector_1).toBe(9.99);
  expect(savedMap.detector_3).toBeUndefined();
  expect(savedMap.item_1).toBe(0);
  expect(Object.keys(savedMap)).toHaveLength(3);
});

test('editing an object[] field (add/edit/remove rows) persists through Save corrections', async ({ page, request }) => {
  const marker = `E2E-ObjectArray-${Date.now()}`;
  const { reportId, extractedFields } = await seedReport(request, {
    model: 'LSRFortessa',
    reportType: 'repair',
    technician: marker,
  });
  // The stub fills exactly one row for an object[] field (§4's _stub_value)
  // — confirmed here so "add a row" below is verifiably adding a second one,
  // not just the table's only content.
  expect(extractedFields.components_replaced as unknown[]).toHaveLength(1);

  await openReport(page, marker);

  const field = page.locator('.field', { hasText: 'components replaced' });
  const dataRows = field.locator('.object-array-row:not(.object-array-head)');
  await expect(dataRows).toHaveCount(1);

  // ObjectArrayInput renders one input per item_schema column, in
  // declaration order — item_schema is now a list of {name, type} columns
  // (schemas.py's ItemSchemaColumn), not a {name: type} dict, specifically
  // because a dict's key order doesn't survive item_schema's round trip
  // through Postgres as jsonb (jsonb re-sorts an object's keys
  // shortest-first, then lexicographically, but preserves a JSON array's
  // element order exactly). Reading the actual header row rather than
  // assuming a fixed index is still the more robust way to write this test
  // regardless — it wouldn't silently start passing for the wrong reason if
  // a future template ever declared components_replaced's columns in a
  // different order.
  // The head row has one trailing empty <span/> after the real column
  // labels (it sits above the per-row "Remove" button column) — filtered
  // out here since it's not a column name.
  const headings = (await field.locator('.object-array-head span').allTextContents())
    .map((h) => h.trim())
    .filter(Boolean);
  // The actual regression check for the JSONB key-reordering bug: with a
  // list-shaped item_schema, these come back in exactly the order
  // seed_templates.py declares them (part_name, part_number, qty) rather
  // than Postgres's old shortest-key-first reordering (qty, part_name,
  // part_number).
  expect(headings).toEqual(['part name', 'part number', 'qty']);
  const colIndex = (label: string) => {
    const i = headings.findIndex((h) => h.trim() === label);
    if (i === -1) throw new Error(`column "${label}" not found among ${JSON.stringify(headings)}`);
    return i;
  };
  const partNameCol = colIndex('part name');
  const partNumberCol = colIndex('part number');
  const qtyCol = colIndex('qty');

  // Edit the stub-filled row in place (ObjectArrayInput.updateRow).
  await dataRows.nth(0).locator('input').nth(partNameCol).fill('Sample injector O-ring');
  await dataRows.nth(0).locator('input').nth(partNumberCol).fill('OR-100');
  await dataRows.nth(0).locator('input').nth(qtyCol).fill('2');

  // Add a second row (ObjectArrayInput.addRow — never exercised before) and
  // fill it in.
  await field.locator('button:has-text("+ Add row")').click();
  await expect(dataRows).toHaveCount(2);
  await dataRows.nth(1).locator('input').nth(partNameCol).fill('Sheath filter');
  await dataRows.nth(1).locator('input').nth(partNumberCol).fill('SF-220');
  await dataRows.nth(1).locator('input').nth(qtyCol).fill('1');

  // Add a third row, then remove it (ObjectArrayInput.removeRow) — proves
  // removal targets the right index rather than always dropping the last
  // (or first) row blindly.
  await field.locator('button:has-text("+ Add row")').click();
  await expect(dataRows).toHaveCount(3);
  // The button's visible text is "Remove" (its aria-label is "Remove row" —
  // matching on the label rather than the text avoids ambiguity with the
  // similarly-worded "+ Add row"/"Remove" controls elsewhere on this field).
  await dataRows.nth(2).locator('button[aria-label="Remove row"]').click();
  await expect(dataRows).toHaveCount(2);

  await page.click('button:has-text("Save corrections")');
  await expect(page.locator('.working-panel')).toHaveCount(0, { timeout: 15_000 });

  const saved = await (await request.get(`${API_BASE}/reports/${reportId}`)).json();
  expect(saved.extracted_fields.components_replaced).toEqual([
    { part_name: 'Sample injector O-ring', part_number: 'OR-100', qty: 2 },
    { part_name: 'Sheath filter', part_number: 'SF-220', qty: 1 },
  ]);
});
