import { type APIRequestContext, type APIResponse, expect } from '@playwright/test';
import { BACKEND_PORT } from '../../../playwright.config';
import { uniquePdf } from '../unique-upload';
import { TIMEOUT } from '../timeouts';

// Everything the specs do through the backend's API rather than the screen: the one place that knows
// where the API is, how a report is seeded, and how test data is cleaned up.

/**
 * Where the API is. The default is the backend playwright.config.ts boots. API_BASE_URL points the
 * same specs at another one (the built bundle served by the backend itself, a deployed environment).
 */
export const API_BASE = process.env.API_BASE_URL ?? `http://localhost:${BACKEND_PORT}`;

/** The response's JSON, after checking the call worked: a failed seed step says which one and why. */
export async function okJson<T = any>(res: APIResponse, what: string): Promise<T> {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json() as Promise<T>;
}

type ExtractionJob = { status: string; error?: string | null };

/** Waits for the worker to finish an extraction job, and fails (with the job) unless it succeeded. */
export async function waitForExtraction(request: APIRequestContext, jobId: string): Promise<void> {
  let job: ExtractionJob | undefined;
  await expect
    .poll(
      async () => {
        job = await (await request.get(`${API_BASE}/extraction-jobs/${jobId}`)).json();
        return job?.status;
      },
      { intervals: [200], timeout: TIMEOUT.flow, message: `extraction job ${jobId} did not finish` }
    )
    .toMatch(/^(succeeded|failed)$/);
  expect(job?.status, `extraction job ${jobId} ended as ${JSON.stringify(job)}`).toBe('succeeded');
}

export type SeedReportOptions = {
  /** The model of an instrument that exists: one of the seeded fleet, or one made by createNumericModel. */
  model: string;
  reportType: string;
  /** The template itself, when the caller made one for the model; then no template is looked up. */
  templateId?: string;
  /** Picks one unit when several share the model. */
  serial?: string;
  /** The unit itself, when the caller already holds it; then the lookup by model and serial is skipped. */
  instrumentId?: string;
  technician?: string;
  /** Written over what the stub extracted. Left alone when omitted. */
  fields?: Record<string, unknown>;
  /** Written with the fields; null clears the date. Left alone when omitted. */
  reportDate?: string | null;
  finalize?: boolean;
  /** Set false to stop after uploading the scan, with the report confirmed to its template but never read. */
  extract?: boolean;
  /** The scan to upload. Its bytes are made unique, so the same scan can be seeded again. */
  file?: { name: string; contents: Buffer | string };
};

export type SeededReport = {
  reportId: string;
  instrumentId: string;
  attachmentId: string;
  /** The fields as they stand after seeding. */
  extractedFields: Record<string, unknown>;
};

/**
 * Makes a report the way the app would hold it after a scan was read: created, confirmed to the
 * instrument and its template, uploaded, extracted by the worker, optionally edited and finalized.
 */
export async function seedReport(request: APIRequestContext, opts: SeedReportOptions): Promise<SeededReport> {
  const report = await okJson<{ id: string }>(
    await request.post(`${API_BASE}/reports`, { data: opts.technician ? { technician_name: opts.technician } : {} }),
    'create report'
  );

  let instrument: { id: string } | undefined = opts.instrumentId ? { id: opts.instrumentId } : undefined;
  if (!instrument) {
    const instruments = await okJson<{ id: string; model: string; serial_number: string }[]>(
      await request.get(`${API_BASE}/instruments`),
      'list instruments'
    );
    instrument = instruments.find((i) => i.model === opts.model && (!opts.serial || i.serial_number === opts.serial));
    expect(instrument, `no instrument with model ${opts.model}${opts.serial ? ` and serial ${opts.serial}` : ''}`).toBeDefined();
  }

  let templateId = opts.templateId;
  if (!templateId) {
    const templates = await okJson<{ id: string }[]>(
      await request.get(`${API_BASE}/report-templates`, { params: { report_type: opts.reportType, model: opts.model } }),
      'list templates'
    );
    expect(templates.length, `no ${opts.reportType} template for ${opts.model}`).toBeGreaterThan(0);
    templateId = templates[0].id;
  }

  await okJson(
    await request.patch(`${API_BASE}/reports/${report.id}/template`, {
      data: { instrument_id: instrument!.id, template_id: templateId },
    }),
    'set template'
  );

  const file = opts.file ?? { name: 'seed.pdf', contents: '%PDF-1.4 seed' };
  const attachment = await okJson<{ id: string }>(
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: { file: { name: file.name, mimeType: 'application/pdf', buffer: uniquePdf(file.contents) } },
    }),
    'upload scan'
  );

  if (opts.extract !== false) {
    const job = await okJson<{ id: string }>(await request.post(`${API_BASE}/attachments/${attachment.id}/extract`), 'start extraction');
    await waitForExtraction(request, job.id);
  }

  if (opts.fields !== undefined || opts.reportDate !== undefined) {
    const data: Record<string, unknown> = {};
    if (opts.fields !== undefined) data.extracted_fields = opts.fields;
    if (opts.reportDate !== undefined) data.report_date = opts.reportDate;
    await okJson(await request.patch(`${API_BASE}/reports/${report.id}/fields`, { data }), 'set fields');
  }

  if (opts.finalize) await okJson(await request.post(`${API_BASE}/reports/${report.id}/finalize`), 'finalize');

  const current = await okJson<{ extracted_fields: Record<string, unknown> }>(await request.get(`${API_BASE}/reports/${report.id}`), 'read report');
  return {
    reportId: report.id,
    instrumentId: instrument!.id,
    attachmentId: attachment.id,
    extractedFields: current.extracted_fields ?? {},
  };
}

/** The ids of every report there is. */
export async function listReportIds(request: APIRequestContext): Promise<string[]> {
  const reports = await okJson<{ id: string }[]>(await request.get(`${API_BASE}/reports`), 'list reports');
  return reports.map((r) => r.id);
}

/**
 * Deletes these reports, finalized ones included. A report whose scan the worker is still reading is
 * refused until it finishes, so that is retried for a moment. Never throws: leftover data must not fail
 * a test that already passed (or hide the reason one failed).
 */
export async function deleteReports(request: APIRequestContext, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await expect
        .poll(async () => (await request.delete(`${API_BASE}/reports/${id}`, { params: { force: 'true' } })).status(), {
          intervals: [200, 500],
          timeout: TIMEOUT.ui,
        })
        .not.toBe(409);
    } catch {
      /* the report could not be removed; the next run's reset clears it */
    }
  }
}

/** Removes every saved report filter, so a spec starts from and leaves an empty list. */
export async function clearSavedFilters(request: APIRequestContext): Promise<void> {
  const { items } = await okJson<{ items: { id: string }[] }>(await request.get(`${API_BASE}/saved-report-filters`), 'list saved filters');
  for (const item of items) await request.delete(`${API_BASE}/saved-report-filters/${item.id}`);
}
