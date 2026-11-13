import { describe, expect, it } from 'vitest';
import { shownTabs } from './topbarOverflow';

const widths = [60, 100, 80, 90]; // gap 4 -> total 330 + 12 = 342
const count = (mask: boolean[]) => mask.filter(Boolean).length;

describe('shownTabs', () => {
  it('keeps every tab when they fit, without counting the More button', () => {
    expect(shownTabs(widths, 342, 70, 4, 0)).toEqual([true, true, true, true]);
    expect(shownTabs(widths, 1000, 70, 4, -1)).toEqual([true, true, true, true]);
  });
  it('drops tabs from the right, one at a time, and leaves room for More', () => {
    expect(shownTabs(widths, 341, 70, 4, -1)).toEqual([true, true, true, false]);
    // 70+4+60+4+100 = 238 fits in 321; adding 4+80 = 322 does not.
    expect(shownTabs(widths, 321, 70, 4, -1)).toEqual([true, true, false, false]);
  });
  it('never folds the active tab: the tab before it folds instead', () => {
    // Last tab active; without it the first three would show at 341.
    expect(shownTabs(widths, 341, 70, 4, 3)).toEqual([true, true, false, true]);
    // 70+4+90 = 164, +4+60 = 228, +4+100 = 332 > 300.
    expect(shownTabs(widths, 300, 70, 4, 3)).toEqual([true, false, false, true]);
  });
  it('keeps the active tab even when it does not fit beside More on its own', () => {
    expect(shownTabs(widths, 100, 70, 4, 1)).toEqual([false, true, false, false]);
    expect(shownTabs(widths, 0, 70, 4, 2)).toEqual([false, false, true, false]);
  });
  it('is monotonic as space shrinks, and the active tab is always shown', () => {
    for (const active of [-1, 0, 1, 2, 3]) {
      let last = Infinity;
      for (let space = 400; space >= 0; space -= 5) {
        const mask = shownTabs(widths, space, 70, 4, active);
        expect(count(mask)).toBeLessThanOrEqual(last);
        if (active >= 0) expect(mask[active]).toBe(true);
        last = count(mask);
      }
    }
  });
  it('returns nothing when not even one tab fits beside More and no tab is active', () => {
    expect(count(shownTabs(widths, 100, 70, 4, -1))).toBe(0);
  });
  it('handles no tabs', () => {
    expect(shownTabs([], 0, 70, 4, -1)).toEqual([]);
  });
});
