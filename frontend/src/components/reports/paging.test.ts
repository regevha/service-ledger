import { describe, expect, it } from 'vitest';
import type { ReportListItem } from '../../api';
import { mergePage } from './paging';

const item = (id: string) => ({ id }) as ReportListItem;

describe('mergePage', () => {
  it('appends the next page in order', () => {
    expect(mergePage([item('a'), item('b')], [item('c')]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('never shows a report twice when the pages shifted by a row', () => {
    expect(mergePage([item('a'), item('b')], [item('b'), item('c')]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps what is shown when the next page is empty', () => {
    expect(mergePage([item('a')], []).map((r) => r.id)).toEqual(['a']);
  });
});
