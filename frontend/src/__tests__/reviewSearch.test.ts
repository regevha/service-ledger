// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { findMatches, searchWords, textMatches } from '../reviewSearch';

describe('searchWords', () => {
  it('lower-cases and splits on spaces; a blank query has no words', () => {
    expect(searchWords('  Pump   2 ')).toEqual(['pump', '2']);
    expect(searchWords('   ')).toEqual([]);
  });
});

describe('textMatches', () => {
  it('needs every word, in any order, ignoring case', () => {
    expect(textMatches('Replaced PUMP, quantity 2', ['pump', '2'])).toBe(true);
    expect(textMatches('Replaced pump', ['pump', '2'])).toBe(false);
  });

  it('never matches an empty query', () => {
    expect(textMatches('anything', [])).toBe(false);
  });
});

describe('findMatches', () => {
  it('finds inputs, the shown choice of a select, and tag chips, and skips empty values', () => {
    document.body.innerHTML = `
      <div id="root">
        <input type="text" value="Laser delay 29">
        <input type="text" value="">
        <select><option value="">none</option></select>
        <select><option value="a">Flow cytometer</option><option value="b" selected>Sorter</option></select>
        <span class="tag-chip">pump<button>×</button></span>
      </div>`;
    const root = document.getElementById('root') as HTMLElement;
    expect(findMatches(root, 'laser')).toHaveLength(1);
    expect(findMatches(root, 'sorter')).toHaveLength(1);
    expect(findMatches(root, 'flow')).toHaveLength(0);
    expect(findMatches(root, 'pump')).toHaveLength(1);
    expect(findMatches(root, '')).toHaveLength(0);
  });
});
