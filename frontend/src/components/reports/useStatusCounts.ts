import { useEffect, useState } from 'react';
import { listReports, type ReportFilters, type ReportStatus } from '../../api';

/**
 * How many reports each status has under the other filters, for the pills above the list. Counted apart
 * from the list itself because that is already narrowed by the status that is chosen.
 * `withoutStatusKey` is the other filters as JSON; `refreshNonce` reloads after leaving a report.
 */
export function useStatusCounts(withoutStatusKey: string, refreshNonce: number) {
  const [statusCounts, setStatusCounts] = useState<Partial<Record<ReportStatus, number>> | null>(null);
  useEffect(() => {
    let cancelled = false;
    listReports(JSON.parse(withoutStatusKey) as ReportFilters)
      .then((all) => {
        if (cancelled) return;
        const counts: Partial<Record<ReportStatus, number>> = {};
        for (const r of all) counts[r.status] = (counts[r.status] ?? 0) + 1;
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
