import type { InstrumentStatus, ReportStatus, ReportType } from './api';

// Shared between several components/*.tsx screens — pulled out to its own
// module rather than exported from any one of them so none of them form a
// circular import (e.g. App.tsx renders AnalyticsScreen, which needs this
// label map back).
export const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  calibration: 'Calibration',
  repair: 'Malfunction / repair',
  preventive_maintenance: 'Preventive maintenance',
  installation_upgrade: 'Installation / upgrade',
};

// InstrumentStatus (models.py's own doc comment: "not specified in the
// spec's data-model table — a reasonable MVP default") — used by the
// instrument detail page's status pill.
export const INSTRUMENT_STATUS_LABEL: Record<InstrumentStatus, string> = {
  active: 'Active',
  maintenance: 'In maintenance',
  retired: 'Retired',
};

// Used by the reports list, a report's detail screen, and an instrument's
// report-history table (components/ReportsListScreen.tsx,
// ReportDetailScreen.tsx, InstrumentDetailScreen.tsx) — moved here alongside
// the two label maps above for the same reason, once those screens split out
// of App.tsx into their own files.
export const STATUS_LABEL: Record<ReportStatus, string> = {
  draft: 'Draft',
  classified: 'Classified',
  extracted: 'Extracted',
  in_review: 'In review',
  finalized: 'Finalized',
};
