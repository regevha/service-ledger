import { conditionsOf } from '../keptSearch';
import { useKeptSearch } from '../keptSearchContext';

/**
 * The conditions of the search in force, one chip each. Tapping a chip takes that one condition out and the screen
 * follows at once, so a wrong reading is fixed without typing the question again. "Clear search" takes it all out.
 * Renders nothing when no search is in force.
 */
export function ActiveSearchChips({ chipTestId, clearTestId, withClear = true }: { chipTestId: string; clearTestId: string; withClear?: boolean }) {
  const { kept, removeCondition, clear } = useKeptSearch();
  if (!kept) return null;
  return (
    <>
      {conditionsOf(kept).map((part) => (
        <button
          key={part.key}
          type="button"
          className="ask-chip removable"
          data-testid={chipTestId}
          aria-label={`Remove: ${part.label}`}
          title="Remove this condition"
          onClick={() => removeCondition(part.key)}
        >
          {part.label}
        </button>
      ))}
      {withClear && (
        <button type="button" className="link-button active-search-clear" data-testid={clearTestId} onClick={clear}>
          Clear search
        </button>
      )}
    </>
  );
}

/**
 * Under the top bar, on every screen, for as long as a search is in force: it stays in view when the page scrolls,
 * so it is never forgotten that the lists and charts below are narrowed. Where the Ask box is on the screen and wide
 * enough to show the same chips under its field (Reports), this line steps aside; on a phone it is always shown.
 */
export function ActiveSearchLine({ view }: { view: string }) {
  const { kept, clear } = useKeptSearch();
  if (!kept) return null;
  return (
    <div
      className={`active-search${view === 'reports' ? ' active-search--box-below' : ''}`}
      role="region"
      aria-label={`Active search: ${kept.text}`}
      data-testid="active-search"
    >
      <span className="active-search-label">Search</span>
      {/* Only the chips scroll sideways when there are many; Clear stays in reach at the right. */}
      <div className="active-search-chips">
        <ActiveSearchChips chipTestId="active-search-chip" clearTestId="active-search-clear" withClear={false} />
      </div>
      <button type="button" className="link-button active-search-clear" data-testid="active-search-clear" onClick={clear}>
        Clear search
      </button>
    </div>
  );
}
