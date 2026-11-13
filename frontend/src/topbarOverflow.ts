/**
 * Which of the top bar's tabs stay in the row, given the space they have.
 *
 * `widths` are the tabs' own widths in order, `gap` is the space between two neighbours,
 * `available` is the width of the tab row and `moreWidth` is the width of the "More" button.
 * `active` is the index of the current view's tab, or -1 when no tab is current.
 *
 * When every tab fits, all stay and no More button is needed, so its width is not counted.
 * Otherwise tabs leave from the right, one at a time, into More, but the active tab never leaves:
 * it keeps its place in the row and the tab before or after it folds instead (user decision, #322).
 * The active tab stays even when it does not fit beside More on its own.
 */
export function shownTabs(widths: number[], available: number, moreWidth: number, gap: number, active: number): boolean[] {
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= available) return widths.map(() => true);
  const shown = widths.map(() => false);
  let used = moreWidth;
  if (active >= 0 && active < widths.length) {
    shown[active] = true;
    used += gap + widths[active];
  }
  for (let i = 0; i < widths.length; i += 1) {
    if (i === active) continue;
    const next = used + gap + widths[i];
    if (next > available) break;
    used = next;
    shown[i] = true;
  }
  return shown;
}
