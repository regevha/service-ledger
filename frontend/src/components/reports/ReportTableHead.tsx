import type { Dispatch, SetStateAction } from 'react';
import { nextSort, SORT_LABEL, type SortKey, type SortState } from '../../reportSort';

/** The column heads of the flat table; each one sorts by its column. */
export function ReportTableHead({
  sort,
  setSort,
}: {
  sort: SortState | null;
  setSort: Dispatch<SetStateAction<SortState | null>>;
}) {
  return (
    <div className="report-row report-row-head">
      {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => {
        const active = sort?.key === key ? sort.direction : null;
        return (
          <button
            key={key}
            type="button"
            className={`sort-head${active ? ' sort-head-active' : ''}`}
            data-sort={active ?? 'none'}
            data-testid={`sort-${key}`}
            title={`Sort by ${SORT_LABEL[key].toLowerCase()}`}
            aria-label={`Sort by ${SORT_LABEL[key].toLowerCase()}${
              active ? `, currently ${active === 'asc' ? 'ascending' : 'descending'}` : ''
            }`}
            onClick={() => setSort((cur) => nextSort(cur, key))}
          >
            {SORT_LABEL[key]}
            <span className="sort-arrow" aria-hidden="true">
              {active === 'asc' ? '▲' : active === 'desc' ? '▼' : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}
