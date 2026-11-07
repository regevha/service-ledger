import type { Dispatch, SetStateAction } from 'react';
import type { ReportFilters, ReportStatus } from '../../api';
import { STATUS_LABEL } from '../../labels';

/** The status pills above the list: All and each status that has reports, with its count. */
export function StatusPills({
  statusCounts,
  chosenStatus,
  setFilters,
}: {
  statusCounts: Partial<Record<ReportStatus, number>>;
  chosenStatus: ReportFilters['status'];
  setFilters: Dispatch<SetStateAction<ReportFilters>>;
}) {
  return (
    <div className="status-filter" role="group" aria-label="Filter by status" data-testid="status-pills">
      <button
        type="button"
        className="status-filter-pill"
        aria-pressed={!chosenStatus}
        onClick={() => setFilters((f) => ({ ...f, status: undefined }))}
      >
        All <span className="status-filter-count">{Object.values(statusCounts).reduce((a, b) => a + (b ?? 0), 0)}</span>
      </button>
      {(['draft', 'classified', 'extracted', 'in_review', 'finalized'] as ReportStatus[])
        .filter((st) => (statusCounts[st] ?? 0) > 0 || chosenStatus === st)
        .map((st) => (
          <button
            key={st}
            type="button"
            className="status-filter-pill"
            aria-pressed={chosenStatus === st}
            onClick={() => setFilters((f) => ({ ...f, status: st }))}
          >
            {STATUS_LABEL[st]} <span className="status-filter-count">{statusCounts[st] ?? 0}</span>
          </button>
        ))}
    </div>
  );
}
