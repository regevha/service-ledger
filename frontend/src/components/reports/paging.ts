import type { ReportListItem } from '../../api';

/** Reports fetched per request on the Reports screen. */
export const REPORTS_PAGE_SIZE = 100;

/** Append a freshly loaded page, skipping any report already shown: a report saved between two requests can shift the pages by a row. */
export function mergePage(have: ReportListItem[], page: ReportListItem[]): ReportListItem[] {
  const seen = new Set(have.map((r) => r.id));
  return [...have, ...page.filter((r) => !seen.has(r.id))];
}
