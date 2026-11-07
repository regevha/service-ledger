import type { Dispatch, SetStateAction } from 'react';
import { SORT_LABEL, type SortKey, type SortState } from '../../reportSort';

/** The "Sort by" selector (the only way to sort on a phone, where the table head is hidden). */
export function SortSelect({
  grouped,
  searching,
  sort,
  setSort,
}: {
  grouped: boolean;
  searching: boolean;
  sort: SortState | null;
  setSort: Dispatch<SetStateAction<SortState | null>>;
}) {
  return (
    <label className={`sort-select-wrap${grouped ? ' sort-select-wrap-grouped' : ''}`}>
      <span>Sort by</span>
      <select
        className="sort-select"
        data-testid="sort-select"
        value={sort ? `${sort.key}:${sort.direction}` : ''}
        onChange={(e) => {
          const [key, direction] = e.target.value.split(':');
          setSort(key ? { key: key as SortKey, direction: direction as 'asc' | 'desc' } : null);
        }}
      >
        <option value="">{searching ? 'Best match' : 'Default order'}</option>
        {(Object.keys(SORT_LABEL) as SortKey[]).flatMap((key) => [
          <option key={`${key}:asc`} value={`${key}:asc`}>{`${SORT_LABEL[key]} ▲`}</option>,
          <option key={`${key}:desc`} value={`${key}:desc`}>{`${SORT_LABEL[key]} ▼`}</option>,
        ])}
      </select>
    </label>
  );
}
