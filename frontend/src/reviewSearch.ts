// Find-on-screen for the review screen: which values on the screen contain the words typed.
//
// The unit of matching is what a person sees: the text of an input, the shown choice of a
// select, a tag chip, or (inside a table) one whole row. Reading the screen rather than the
// report's data means dates, numbers and choices match as they are displayed.

/** The words of a query: split on spaces, lower-cased. Empty for a blank query. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when every word of the query is somewhere in `text`, in any order, ignoring case. */
export function textMatches(text: string, words: string[]): boolean {
  if (words.length === 0) return false;
  const haystack = text.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** What one element shows as its value, or null when it holds nothing to search (an empty select, the "add a value" box). */
function shownValue(el: HTMLElement): string | null {
  if (el instanceof HTMLSelectElement) {
    return el.value === '' ? null : (el.selectedOptions[0]?.textContent ?? null);
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value;
  }
  // A tag chip: its text, without the "×" button.
  return el.firstChild?.textContent ?? el.textContent;
}

// The elements that carry a value. The "add a value" box of a tag list and the hidden native date picker are not values.
const VALUE_SELECTOR = [
  'input[type="text"]:not(.date-input-native)',
  'input[type="number"]',
  'textarea',
  'select',
  '.tag-chip',
].join(', ');

/**
 * The elements to highlight for a query inside `root`, in screen order. A value inside a table
 * row counts with the rest of its row: the row matches when all the words are in the row (so
 * "pump 2" finds a row with part "pump" and quantity 2), and the row is what is highlighted.
 */
export function findMatches(root: HTMLElement, query: string): HTMLElement[] {
  const words = searchWords(query);
  if (words.length === 0) return [];
  const hits: HTMLElement[] = [];
  const seenRows = new Set<Element>();
  for (const el of root.querySelectorAll<HTMLElement>(VALUE_SELECTOR)) {
    if (el.closest('.tag-input') && !el.classList.contains('tag-chip')) continue;
    const row = el.closest('.object-array-row:not(.object-array-head)');
    if (row) {
      if (seenRows.has(row)) continue;
      seenRows.add(row);
      const rowText = [...row.querySelectorAll<HTMLElement>(VALUE_SELECTOR)].map((v) => shownValue(v) ?? '').join(' ');
      if (textMatches(rowText, words)) hits.push(row as HTMLElement);
      continue;
    }
    const text = shownValue(el);
    if (text !== null && textMatches(text, words)) hits.push(el);
  }
  return hits;
}
