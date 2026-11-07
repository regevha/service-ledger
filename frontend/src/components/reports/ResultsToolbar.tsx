import { SORT_LABEL, type SortState } from '../../reportSort';
import type { GroupMode } from './grouping';

/** The line above the results: how many reports, how they are ordered, and the Group selector. */
export function ResultsToolbar({
  count,
  searching,
  query,
  sort,
  groupMode,
  onGroupMode,
}: {
  count: number;
  searching: boolean;
  query: string | undefined;
  sort: SortState | null;
  groupMode: GroupMode;
  onGroupMode: (mode: GroupMode) => void;
}) {
  return (
    <div className="table-toolbar">
      <span className="table-toolbar-count" data-testid="result-count">
        {searching
          ? `${count} finalized report${count === 1 ? '' : 's'} match “${query}” · ${
              sort ? `sorted by ${SORT_LABEL[sort.key].toLowerCase()}` : 'best match first'
            }`
          : `${count} report${count === 1 ? '' : 's'}${
              sort ? ` · sorted by ${SORT_LABEL[sort.key].toLowerCase()}` : ''
            }`}
      </span>
      <label className="group-select-wrap">
        <span>Group</span>
        <select
          className="group-select"
          data-testid="group-select"
          value={groupMode}
          onChange={(e) => onGroupMode(e.target.value === 'none' ? 'none' : e.target.value === 'model' ? 'model' : 'instrument')}
        >
          <option value="instrument">Instrument</option>
          <option value="model">Model</option>
          <option value="none">None</option>
        </select>
      </label>
    </div>
  );
}
