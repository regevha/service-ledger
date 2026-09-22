import type { ReportType } from './api';

// Shared between App.tsx and components/AnalyticsScreen.tsx — pulled out to
// its own module rather than exported from App.tsx so the two don't form a
// circular import (App.tsx renders AnalyticsScreen, which needs this label
// map back).
export const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  calibration: 'Calibration',
  repair: 'Malfunction / repair',
  preventive_maintenance: 'Preventive maintenance',
};
