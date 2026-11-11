import { test, expect } from './coverage';
import { addRecent, cleanRecent, RECENT_MAX } from '../../src/recentSearches';
import { problemOf, transcriptOf } from '../../src/speech';

// Pure logic behind recent searches (src/recentSearches.ts) and voice (src/speech.ts); no browser needed.

test.describe('recent searches', () => {
  test('the newest is first and a repeat moves up instead of doubling, in any letter case', () => {
    expect(addRecent(['b', 'a'], 'c')).toEqual(['c', 'b', 'a']);
    expect(addRecent(['b', 'a'], 'A')).toEqual(['A', 'b']);
    expect(addRecent(['b', 'a'], '  b  ')).toEqual(['b', 'a']);
  });
  test('only the last five are kept', () => {
    let list: string[] = [];
    for (const word of ['1', '2', '3', '4', '5', '6', '7']) list = addRecent(list, word);
    expect(list).toEqual(['7', '6', '5', '4', '3']);
    expect(list).toHaveLength(RECENT_MAX);
  });
  test('an empty question is not added', () => {
    expect(addRecent(['a'], '   ')).toEqual(['a']);
  });
  test('whatever is stored, only sane distinct strings come back', () => {
    expect(cleanRecent('nope')).toEqual([]);
    expect(cleanRecent(null)).toEqual([]);
    expect(cleanRecent({ 0: 'a' })).toEqual([]);
    expect(cleanRecent(['a', 3, '', '   ', 'A', 'x'.repeat(301), 'b'])).toEqual(['a', 'b']);
    expect(cleanRecent(['1', '2', '3', '4', '5', '6', '7'])).toHaveLength(RECENT_MAX);
  });
});

test.describe('voice', () => {
  const result = (...words: string[]) => ({ results: words.map((transcript) => [{ transcript }]) });
  test('the spoken words are joined and tidied', () => {
    expect(transcriptOf(result('repairs of the', '  FACSAria   III '))).toBe('repairs of the FACSAria III');
    expect(transcriptOf(result())).toBe('');
    expect(transcriptOf(result(''))).toBe('');
  });
  test('each error becomes something the person can act on; stopping on purpose is not an error', () => {
    expect(problemOf('not-allowed')).toBe('blocked');
    expect(problemOf('service-not-allowed')).toBe('blocked');
    expect(problemOf('no-speech')).toBe('nothing');
    expect(problemOf('audio-capture')).toBe('nothing');
    expect(problemOf('network')).toBe('failed');
    expect(problemOf('aborted')).toBeNull();
  });
});
