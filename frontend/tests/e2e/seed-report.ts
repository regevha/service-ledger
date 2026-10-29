import { type APIRequestContext, expect } from '@playwright/test';
import { uniquePdf } from './unique-upload';
import { BACKEND_PORT } from '../../playwright.config';
import { TIMEOUT } from './timeouts';

export const API_BASE = `http://localhost:${BACKEND_PORT}`;

/** Creates a report for an instrument of `model`, reads it, sets exactly these fields and finalizes it. */
export async function seedFinalizedReport(
  request: APIRequestContext,
  opts: { model: string; reportType: string; extractedFields: Record<string, unknown> }
): Promise<string> {
  const report = await (await request.post(`${API_BASE}/reports`, { data: {} })).json();

  const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
  const instrument = instruments.find((i: { model: string }) => i.model === opts.model);
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: opts.reportType, model: opts.model } })
  ).json();
  await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: instrument.id, template_id: templates[0].id },
  });

  // A real attachment + extract cycle is what moves the report into
  // "extracted" status (a prerequisite for finalize) — the stub's own
  // extracted values don't matter since the PATCH below overwrites them
  // with this test's exact, deterministic fields.
  const attachment = await (
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: uniquePdf('%PDF-1.4 seed') } },
    })
  ).json();
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  await expect
    .poll(async () => (await (await request.get(`${API_BASE}/extraction-jobs/${job.id}`)).json()).status, {
      intervals: [200],
      timeout: TIMEOUT.flow,
    })
    .toMatch(/^(succeeded|failed)$/);

  await request.patch(`${API_BASE}/reports/${report.id}/fields`, { data: { extracted_fields: opts.extractedFields } });
  await request.post(`${API_BASE}/reports/${report.id}/finalize`);
  return report.id as string;
}
