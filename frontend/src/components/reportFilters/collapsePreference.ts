const COLLAPSE_KEY = 'sl.filters.collapsed';

// Per-viewer convenience only (shared by both tabs): browser storage can be empty or throw.
export function readCollapsed(): boolean {
  try {
    const saved = localStorage.getItem(COLLAPSE_KEY);
    if (saved === 'yes') return true;
    if (saved === 'no') return false;
  } catch {
    /* fall through to the default */
  }
  // Never chosen: folded on a phone, so the list is on the first screen; open elsewhere.
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 620px)').matches === true;
}
export function writeCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? 'yes' : 'no');
  } catch {
    /* not remembered; nothing else depends on it */
  }
}
