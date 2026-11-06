import { API_BASE, ApiError, apiFetch } from './http';
import type { Attachment, ExtractionJob, PromptPreview } from './types';

// ---------- Attachments / extraction ----------

export function uploadAttachment(reportId: string, file: File): Promise<Attachment> {
  const form = new FormData();
  form.append('file', file);
  return apiFetch(`/reports/${reportId}/attachments`, { method: 'POST', body: form });
}

// Not routed through apiFetch — same reasoning as reportsExportUrl above:
// this is a direct link href (opened in a new tab, or downloaded), not a
// fetch, so the browser handles the PDF/image response and its
// Content-Disposition filename itself rather than any JS/blob plumbing here.
//
// `inline` asks for the file to be displayed rather than downloaded: needed for
// an <iframe>, which stays blank when the response is an attachment.
export function attachmentFileUrl(attachmentId: string, opts: { inline?: boolean } = {}): string {
  return `${API_BASE}/attachments/${attachmentId}/file${opts.inline ? '?inline=1' : ''}`;
}

/** Page count of the stored scan (an image is one page), and a page rendered as a PNG for the phone's Scan view. */
export function getAttachmentPageCount(attachmentId: string): Promise<{ page_count: number }> {
  return apiFetch(`/attachments/${attachmentId}/pages`);
}

export function attachmentPageUrl(attachmentId: string, page: number, width = 900): string {
  return `${API_BASE}/attachments/${attachmentId}/pages/${page}?width=${width}`;
}

// Both of these now only enqueue a job and return immediately (202) — the
// actual Claude vision call happens in the background worker (app/worker.py,
// SL-ARCH-001 §3), not inline in the request (a vision call runs seconds,
// not milliseconds, and §3 is explicit that shouldn't block an HTTP
// request). Callers poll the returned job with pollExtractionJob below.
export function classifyAttachment(attachmentId: string): Promise<ExtractionJob> {
  return apiFetch(`/attachments/${attachmentId}/classify`, { method: 'POST' });
}

export function extractAttachment(attachmentId: string): Promise<ExtractionJob> {
  return apiFetch(`/attachments/${attachmentId}/extract`, { method: 'POST' });
}

export function getExtractionJob(jobId: string): Promise<ExtractionJob> {
  return apiFetch(`/extraction-jobs/${jobId}`);
}

// Polls GET /extraction-jobs/{id} (§9) until the background worker (§3)
// moves it out of pending/classifying/extracting. Resolves with the job
// either way — succeeded or failed is a normal outcome for a caller to
// branch on (see App.tsx's runClassification/runExtraction), not an
// exception; only a genuinely stuck job (past timeoutMs) throws.
export function approveExtractionJob(jobId: string): Promise<ExtractionJob> {
  return apiFetch(`/extraction-jobs/${jobId}/approve`, { method: 'POST' });
}

export function cancelExtractionJob(jobId: string): Promise<ExtractionJob> {
  return apiFetch(`/extraction-jobs/${jobId}/cancel`, { method: 'POST' });
}

// VIEW_PROMPTS (debug): when the backend parks a job as 'awaiting_approval', the
// poll below hands the prompt to this handler (the intake screen shows it) and
// sends the person's answer back. No handler: the poll just keeps waiting.
let promptApprovalHandler: ((preview: PromptPreview) => Promise<boolean>) | null = null;
export function setPromptApprovalHandler(handler: ((preview: PromptPreview) => Promise<boolean>) | null): void {
  promptApprovalHandler = handler;
}

// A signal stops the wait early (the person pressed Cancel); the job itself is cancelled
// separately with cancelExtractionJob.
export class PollAborted extends Error {
  constructor() {
    super('Stopped waiting for the job.');
    this.name = 'PollAborted';
  }
}

export async function pollExtractionJob(
  jobId: string,
  opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ExtractionJob> {
  const intervalMs = opts.intervalMs ?? 400;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  let deadline = Date.now() + timeoutMs;
  for (;;) {
    if (opts.signal?.aborted) throw new PollAborted();
    const job = await getExtractionJob(jobId);
    if (opts.signal?.aborted) throw new PollAborted();
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    if (job.status === 'awaiting_approval' && job.prompt_preview && promptApprovalHandler) {
      const send = await promptApprovalHandler(job.prompt_preview);
      if (!send) return cancelExtractionJob(jobId);
      await approveExtractionJob(jobId);
      deadline = Date.now() + timeoutMs; // the person's reading time does not count
      continue;
    }
    if (job.status === 'awaiting_approval') deadline = Date.now() + timeoutMs;
    if (Date.now() >= deadline) {
      throw new ApiError(0, `Extraction job ${jobId} did not finish within ${Math.round(timeoutMs / 1000)}s.`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
