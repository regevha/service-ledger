import { describe, expect, it } from 'vitest';
import { searchWords, textMatches } from './reviewSearch';

// findMatches needs a DOM (HTMLElement, querySelectorAll); the Vitest environment is node, so it is not covered here.

describe('searchWords', () => {
  it('lower-cases and splits on any whitespace', () => {
    expect(searchWords('Pump  2\tFLOW\nrate')).toEqual(['pump', '2', 'flow', 'rate']);
  });

  it('is empty for a blank query', () => {
    expect(searchWords('')).toEqual([]);
    expect(searchWords('   \t\n ')).toEqual([]);
  });

  it('drops leading and trailing spaces', () => {
    expect(searchWords('  valve ')).toEqual(['valve']);
  });
});

describe('textMatches', () => {
  it('never matches with no words', () => {
    expect(textMatches('anything', [])).toBe(false);
    expect(textMatches('', [])).toBe(false);
  });

  it('matches when every word is present, in any order', () => {
    expect(textMatches('Replaced pump 2 seal', searchWords('seal PUMP'))).toBe(true);
  });

  it('fails when one word is missing', () => {
    expect(textMatches('Replaced pump seal', searchWords('pump valve'))).toBe(false);
  });

  it('matches substrings inside a word', () => {
    expect(textMatches('calibration', ['brat'])).toBe(true);
  });

  it('ignores the case of the text', () => {
    expect(textMatches('LASER Delay', ['laser', 'delay'])).toBe(true);
  });

  it('does not match anything in empty text', () => {
    expect(textMatches('', ['a'])).toBe(false);
  });
});
