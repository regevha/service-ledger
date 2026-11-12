import { describe, expect, it } from 'vitest';
import { diffWords } from '../diffWords';

describe('diffWords', () => {
  it('marks nothing when the texts are the same', () => {
    const { left, right } = diffWords('check the pump', 'check the pump');
    expect(left).toEqual([{ text: 'check the pump', changed: false }]);
    expect(right).toEqual(left);
  });

  it('marks only the words one side has', () => {
    const { left, right } = diffWords('replace the old pump', 'replace the new pump');
    expect(left).toEqual([
      { text: 'replace the', changed: false },
      { text: 'old', changed: true },
      { text: 'pump', changed: false },
    ]);
    expect(right).toEqual([
      { text: 'replace the', changed: false },
      { text: 'new', changed: true },
      { text: 'pump', changed: false },
    ]);
  });

  it('handles an empty side and ignores extra whitespace', () => {
    expect(diffWords('', 'a  b')).toEqual({ left: [], right: [{ text: 'a b', changed: true }] });
  });

  it('shows very long texts whole, all marked', () => {
    const long = Array.from({ length: 1600 }, (_, i) => `w${i}`).join(' ');
    const { left, right } = diffWords(long, long);
    expect(left).toHaveLength(1);
    expect(left[0].changed).toBe(true);
    expect(right[0].changed).toBe(true);
  });
});
