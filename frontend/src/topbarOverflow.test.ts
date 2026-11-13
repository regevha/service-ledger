import { describe, expect, it } from 'vitest';
import { visibleTabCount } from './topbarOverflow';

const widths = [60, 100, 80, 90]; // gap 4 -> total 330 + 12 = 342

describe('visibleTabCount', () => {
  it('keeps every tab when they fit, without counting the More button', () => {
    expect(visibleTabCount(widths, 342, 70, 4)).toBe(4);
    expect(visibleTabCount(widths, 1000, 70, 4)).toBe(4);
  });
  it('drops tabs from the right, one at a time, and leaves room for More', () => {
    expect(visibleTabCount(widths, 341, 70, 4)).toBe(3);
    expect(visibleTabCount(widths, 321, 70, 4)).toBe(2); // 70+4+60+4+100+4+80 = 322 fits in 341; adding 90 does not
  });
  it('is monotonic as space shrinks', () => {
    let last = Infinity;
    for (let space = 400; space >= 0; space -= 5) {
      const n = visibleTabCount(widths, space, 70, 4);
      expect(n).toBeLessThanOrEqual(last);
      last = n;
    }
  });
  it('returns 0 when not even one tab fits beside More', () => {
    expect(visibleTabCount(widths, 100, 70, 4)).toBe(0);
    expect(visibleTabCount(widths, 0, 70, 4)).toBe(0);
  });
  it('handles no tabs', () => {
    expect(visibleTabCount([], 0, 70, 4)).toBe(0);
  });
});
