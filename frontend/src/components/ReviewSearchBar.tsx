import type { RefObject } from 'react';

/**
 * The search box of the review screen: type words, see "3 of 17", step through the matches with
 * Enter / Shift+Enter or the arrows. Esc closes it. The fields stay where they are; the screen
 * only marks the matching ones.
 */
export function ReviewSearchBar({
  query,
  count,
  current,
  inputRef,
  onChange,
  onNext,
  onPrevious,
  onClose,
}: {
  query: string;
  count: number;
  current: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (q: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}) {
  const typed = query.trim() !== '';
  const status = !typed ? '' : count === 0 ? 'No matches' : `${current + 1} of ${count}`;
  return (
    <div className="review-search" role="search" data-testid="review-search">
      <input
        ref={inputRef}
        type="search"
        className="review-search-input"
        aria-label="Search the values on this screen"
        placeholder="Search values"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrevious();
            else onNext();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="review-search-count" role="status" aria-live="polite" data-testid="review-search-count">
        {status}
      </span>
      <button type="button" className="btn small" aria-label="Previous match" disabled={count === 0} onClick={onPrevious}>
        ↑
      </button>
      <button type="button" className="btn small" aria-label="Next match" disabled={count === 0} onClick={onNext}>
        ↓
      </button>
      <button type="button" className="btn small" aria-label="Close search" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
