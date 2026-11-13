import { useEffect, useState } from 'react';
import { countReports, type ReportFilters, type ReportStatus } from '../../api';

const STATUSES: ReportStatus[] = ['draft', 'classified', 'extracted', 'in_review', 'finalized'];

/**
 * How many reports each status has under the other filters, for the pills above the list. Counted apart
 * from the list itself because that is already narrowed by the status that is chosen. One small request per
 * status that only asks for the total, so no report rows are loaded just to be counted.
 * `withoutStatusKey` is the other filters as JSON; `refreshNonce` reloads after leaving a report.
 */
export function useStatusCounts(withoutStatusKey: string, refreshNonce: number) {
  const [statusCounts, setStatusCounts] = useState<Partial<Record<ReportStatus, number>> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const filters = JSON.parse(withoutStatusKey) as ReportFilters;
    Promise.all(STATUSES.map((status) => countReports({ ...filters, status })))
      .then((totals) => {
        if (cancelled) return;
        const counts: Partial<Record<ReportStatus, number>> = {};
        STATUSES.forEach((status, i) => {
          if (totals[i] > 0) counts[status] = totals[i];
        });
        setStatusCounts(counts);
      })
      .catch(() => {
        if (!cancelled) setStatusCounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [withoutStatusKey, refreshNonce]);

  return statusCounts;
}
