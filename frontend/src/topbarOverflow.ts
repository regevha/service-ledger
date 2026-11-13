/**
 * How many of the top bar's tabs fit in the space they have.
 *
 * `widths` are the tabs' own widths in order, `gap` is the space between two neighbours,
 * `available` is the width of the tab row and `moreWidth` is the width of the "More" button.
 * Tabs leave from the right: the answer is how many stay visible from the left.
 * When every tab fits, no More button is needed, so its width is not counted.
 */
export function visibleTabCount(widths: number[], available: number, moreWidth: number, gap: number): number {
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= available) return widths.length;
  let used = moreWidth;
  let count = 0;
  for (const w of widths) {
    const next = used + gap + w;
    if (next > available) break;
    used = next;
    count += 1;
  }
  return count;
}
