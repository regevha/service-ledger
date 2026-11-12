import { describe, expect, it } from 'vitest';
import { diffWords } from './diffWords';

describe('diffWords', () => {
  it('returns no segments for two empty or blank texts', () => {
    expect(diffWords('', '')).toEqual({ left: [], right: [] });
    expect(diffWords('  \n\t ', '   ')).toEqual({ left: [], right: [] });
  });

  it('shows identical texts as one unchanged segment each', () => {
    const seg = [{ text: 'alpha beta gamma', changed: false }];
    expect(diffWords('alpha beta gamma', 'alpha beta gamma')).toEqual({ left: seg, right: seg });
  });

  it('ignores differences in whitespace only', () => {
    const r = diffWords('alpha   beta\nGamma', ' alpha beta Gamma ');
    expect(r.left).toEqual([{ text: 'alpha beta Gamma', changed: false }]);
    expect(r.right).toEqual(r.left);
  });

  it('marks a replaced word on both sides and merges neighbours', () => {
    expect(diffWords('one two three four', 'one 2 three four')).toEqual({
      left: [
        { text: 'one', changed: false },
        { text: 'two', changed: true },
        { text: 'three four', changed: false },
      ],
      right: [
        { text: 'one', changed: false },
        { text: '2', changed: true },
        { text: 'three four', changed: false },
      ],
    });
  });

  it('marks an insertion only on the side that has the word', () => {
    const r = diffWords('red blue', 'red green blue');
    expect(r.left).toEqual([{ text: 'red blue', changed: false }]);
    expect(r.right).toEqual([
      { text: 'red', changed: false },
      { text: 'green', changed: true },
      { text: 'blue', changed: false },
    ]);
  });

  it('marks everything when one side is empty', () => {
    expect(diffWords('', 'new words')).toEqual({ left: [], right: [{ text: 'new words', changed: true }] });
    expect(diffWords('old words', '')).toEqual({ left: [{ text: 'old words', changed: true }], right: [] });
  });

  it('is case sensitive', () => {
    const r = diffWords('Alpha', 'alpha');
    expect(r.left).toEqual([{ text: 'Alpha', changed: true }]);
    expect(r.right).toEqual([{ text: 'alpha', changed: true }]);
  });

  it('marks everything changed past 1500 words on either side', () => {
    const big = Array.from({ length: 1501 }, (_, i) => `w${i}`).join(' ');
    const r = diffWords(big, big);
    expect(r.left).toEqual([{ text: big, changed: true }]);
    expect(r.right).toEqual([{ text: big, changed: true }]);
    // The boundary itself is still diffed.
    const edge = Array.from({ length: 1500 }, (_, i) => `w${i}`).join(' ');
    expect(diffWords(edge, edge).left).toEqual([{ text: edge, changed: false }]);
  });
});
