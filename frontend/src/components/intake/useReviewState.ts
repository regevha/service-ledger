import { useState } from 'react';
import { type ClassificationResult, type Report, type ReportTemplate } from '../../api';
import { reviewSnapshot } from '../../reviewSnapshot';

/**
 * The report being taken in and what has been read from it: the draft report, its classification,
 * scan, template, extracted fields and the save status. Moved out of IntakeFlow unchanged; the
 * setters are still handed out one by one, and `resetToIntake`'s twelve resets and the
 * "extraction finished" updates are now one call each.
 */
export function useReviewState() {
  const [report, setReport] = useState<Report | null>(null);
  const [classification, setClassification] = useState<ClassificationResult | null>(null);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [template, setTemplate] = useState<ReportTemplate | null>(null);
  const [fieldConfidences, setFieldConfidences] = useState<Record<string, number>>({});
  // Measured in the browser, from submitting the extraction to the job finishing; shown on Review & finalize only.
  const [extractionSeconds, setExtractionSeconds] = useState<number | null>(null);
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [reportDate, setReportDate] = useState<string | null>(null);
  // What the form held when it was last extracted or saved; the form differs from it exactly when
  // there are unsaved edits (see reviewSnapshot).
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  // A save or finalize request in flight, and why the last one failed. Both live on the review screen
  // itself, so a failure keeps the form, the scan view and the "checked" marks where they were.
  const [saving, setSaving] = useState<'save' | 'finalize' | null>(null);
  const [saveError, setSaveError] = useState<{ message: string; finalize: boolean } | null>(null);

  /** Forget everything about the current report (back to a clean upload screen). */
  function resetReview() {
    setReport(null);
    setClassification(null);
    setAttachmentId(null);
    setTemplate(null);
    setFieldConfidences({});
    setExtractionSeconds(null);
    setFields({});
    setReportDate(null);
    setSavedSnapshot(null);
    setSaving(null);
    setSaveError(null);
  }

  /** Show a freshly extracted report on the review screen. */
  function loadExtraction(refreshed: Report, confidences: Record<string, number>, seconds: number) {
    setReport(refreshed);
    setFieldConfidences(confidences);
    setExtractionSeconds(seconds);
    setFields(refreshed.extracted_fields ?? {});
    setReportDate(refreshed.report_date);
    setSavedSnapshot(reviewSnapshot(refreshed.extracted_fields ?? {}, refreshed.report_date));
    setSaveError(null);
  }

  return {
    report, setReport,
    classification, setClassification,
    attachmentId, setAttachmentId,
    template, setTemplate,
    fieldConfidences,
    extractionSeconds,
    fields, setFields,
    reportDate, setReportDate,
    savedSnapshot, setSavedSnapshot,
    saving, setSaving,
    saveError, setSaveError,
    resetReview,
    loadExtraction,
  };
}
