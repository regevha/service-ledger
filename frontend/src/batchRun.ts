import {
  ApiError,
  PollAborted,
  cancelExtractionJob,
  classifyAttachment,
  createReport,
  deleteReport,
  extractAttachment,
  getReport,
  getTranslation,
  pollExtractionJob,
  translateAttachment,
  uploadAttachment,
  type ClassificationResult,
} from './api';
import { prepareUpload } from './imageUpload';
import { stateForReportStatus, type BatchItem } from './batchState';

// Several files at once: each runs the same steps the New report wizard runs for one (create the report, send
// the file, check the language, identify the instrument and form, read the fields), without the screens in
// between. A file that needs a person's choice stops with a plain reason; one that is read stops at "ready"
// and is checked and finalized on the normal report screen.

/**
 * Runs one file through the steps. `update` reports each change; it never throws, and a problem is a state the
 * screen shows, not an exception. An empty draft report is removed whenever the file does not go on.
 */
export async function runItem(
  file: File,
  technician: string | null,
  update: (patch: Partial<BatchItem>) => void,
  signal: AbortSignal
): Promise<void> {
  let reportId: string | undefined;
  let jobId: string | undefined;
  const dropDraft = async () => {
    if (reportId) await deleteReport(reportId).catch(() => undefined);
    reportId = undefined;
    update({ reportId: undefined });
  };
  try {
    update({ state: 'uploading', message: undefined });
    const report = await createReport({ technician_name: technician });
    reportId = report.id;
    update({ reportId });
    let attachment;
    try {
      attachment = await uploadAttachment(report.id, await prepareUpload([file]));
    } catch (e) {
      await dropDraft();
      if (e instanceof ApiError && e.status === 409 && e.existingReportId) {
        update({ state: 'duplicate', existingReportId: e.existingReportId, message: 'This exact file was already read.' });
        return;
      }
      if (e instanceof ApiError && [413, 415, 422].includes(e.status)) {
        update({ state: 'failed', message: e.message });
        return;
      }
      throw e;
    }

    update({ state: 'language' });
    const translation = await translateAttachment(attachment.id);
    jobId = translation.id;
    const translated = await pollExtractionJob(translation.id, { timeoutMs: 300_000, signal });
    if (translated.status === 'failed') throw new ApiError(0, translated.error_message || 'Checking the language failed.');
    if ((await getTranslation(attachment.id)).status === 'pending_review') {
      await dropDraft();
      update({ state: 'attention', message: 'A Hebrew form. Upload it on its own in New report, where the translation is checked.' });
      return;
    }

    update({ state: 'identifying' });
    const classification = await classifyAttachment(attachment.id);
    jobId = classification.id;
    const classified = await pollExtractionJob(classification.id, { signal });
    if (classified.status === 'failed') throw new ApiError(0, classified.error_message || 'Identifying the form failed.');
    const result = classified.classification as unknown as ClassificationResult;
    if (!result.resolved_template_id || !result.resolved_instrument_id) {
      const guess = [result.instrument?.value, result.report_type?.value].filter(Boolean).join(' / ');
      await dropDraft();
      update({
        state: 'attention',
        message: `Could not tell the instrument and form${guess ? ` (looks like ${guess})` : ''}. Upload it on its own in New report to choose by hand.`,
      });
      return;
    }

    update({ state: 'reading', instrument: result.instrument?.value, reportType: result.report_type?.value });
    const extraction = await extractAttachment(attachment.id);
    jobId = extraction.id;
    const read = await pollExtractionJob(extraction.id, { signal });
    if (read.status === 'failed') throw new ApiError(0, read.error_message || 'Reading the fields failed.');
    const done = await getReport(report.id);
    update({ state: stateForReportStatus(done.status), message: undefined });
  } catch (e) {
    if (e instanceof PollAborted || signal.aborted) {
      if (jobId) await cancelExtractionJob(jobId).catch(() => undefined);
      await dropDraft();
      update({ state: 'failed', message: 'Stopped.' });
      return;
    }
    // The draft holds nothing worth keeping, and a retry makes a fresh one.
    await dropDraft();
    update({ state: 'failed', message: e instanceof ApiError ? e.message : 'Something went wrong. Try this file again on its own.' });
  }
}
