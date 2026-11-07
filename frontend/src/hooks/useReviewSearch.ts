import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { findMatches } from '../reviewSearch';

const HIT = 'data-search-hit';
const CURRENT = 'data-search-current';

/**
 * Find-on-screen state for the review screen's field list: whether the search box is open, the
 * typed words, and which match is the current one. Matches are marked with data attributes
 * (React never owns those), recomputed after every render so a value typed meanwhile is
 * noticed, and removed again when the search closes. Nothing here changes a value or
 * touches the "checked" marks.
 */
export function useReviewSearch(
  listRef: RefObject<HTMLElement | null>,
  available: boolean,
  // The values on screen: when either changes, the matches are looked for again.
  fields: unknown,
  reportDate: unknown
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Where the keyboard was before the search opened, so Esc can put it back.
  const returnTo = useRef<HTMLElement | null>(null);

  const active = open && available && query.trim() !== '';

  // Mark the matches (and the current one) whenever the words, the chosen match or the values change; only touch state when the count changes.
  useLayoutEffect(() => {
    const root = listRef.current;
    if (!root) return;
    for (const el of root.querySelectorAll(`[${HIT}], [${CURRENT}]`)) {
      el.removeAttribute(HIT);
      el.removeAttribute(CURRENT);
    }
    if (!active) {
      if (count !== 0) setCount(0);
      return;
    }
    const hits = findMatches(root, query);
    if (hits.length !== count) setCount(hits.length);
    const current = hits.length === 0 ? -1 : Math.min(index, hits.length - 1);
    hits.forEach((el, i) => {
      el.setAttribute(HIT, 'true');
      if (i === current) el.setAttribute(CURRENT, 'true');
    });
  }, [listRef, active, query, index, count, fields, reportDate]);

  // Bring the current match into view when the words or the chosen match change (not on every keystroke elsewhere).
  useEffect(() => {
    if (!active) return;
    listRef.current?.querySelector<HTMLElement>(`[${CURRENT}]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [active, query, index, count, listRef]);

  const openSearch = useCallback(() => {
    if (!available) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && listRef.current?.contains(focused)) returnTo.current = focused;
    setOpen(true);
    // The box exists after this render; focus it then.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [available, listRef]);

  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery('');
    setIndex(0);
    const back = returnTo.current;
    returnTo.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, []);

  const step = useCallback(
    (delta: 1 | -1) => {
      if (count === 0) return;
      setIndex((i) => (Math.min(i, count - 1) + delta + count) % count);
    },
    [count]
  );

  const changeQuery = useCallback((q: string) => {
    setQuery(q);
    setIndex(0);
  }, []);

  // Ctrl/Cmd+F opens this search instead of the browser's own, which cannot see inside inputs.
  useEffect(() => {
    if (!available) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openSearch();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [available, openSearch]);

  return {
    open: open && available,
    query,
    count,
    current: count === 0 ? 0 : Math.min(index, count - 1),
    inputRef,
    openSearch,
    closeSearch,
    changeQuery,
    next: () => step(1),
    previous: () => step(-1),
  };
}
