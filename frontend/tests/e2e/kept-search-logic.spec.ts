import { test, expect } from './coverage';
import {
  clearKeptSearch,
  conditionsOf,
  criteriaOf,
  goneKeys,
  goneNotice,
  hasCriteria,
  readKeptSearch,
  recordKeysOf,
  sameFilters,
  withoutCondition,
  writeKeptSearch,
} from '../../src/keptSearch';

// Pure logic behind the kept search (src/keptSearch.ts); no browser needed. Browser storage is faked.

class FakeStorage {
  items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

const KEY = 'sl.ask.kept';
const g = globalThis as unknown as { localStorage?: unknown };
let storage: FakeStorage;

test.beforeEach(() => {
  storage = new FakeStorage();
  g.localStorage = storage;
});
test.afterEach(() => {
  delete g.localStorage;
});

const understood = [
  { key: 'report_type', label: 'Repair' },
  { key: 'technician', label: 'Lab manager: Zed' },
];

test('criteria: only known, non-empty text values count', () => {
  expect(criteriaOf({ report_type: 'repair', technician: '', q: undefined })).toEqual({ report_type: 'repair' });
  // Anything else in a stored or built object is left out (an Analytics-only maker, a number, junk).
  expect(criteriaOf({ report_type: 'repair', manufacturer: 'BD', extra: 4 } as never)).toEqual({ report_type: 'repair' });
  expect(hasCriteria({})).toBe(false);
  expect(hasCriteria({ technician: ' ' })).toBe(true);
  expect(hasCriteria({ technician: '' })).toBe(false);
});

test('sameFilters: unset and empty are the same; any real difference is not', () => {
  expect(sameFilters({}, { technician: '', q: undefined })).toBe(true);
  expect(sameFilters({ report_type: 'repair' }, { report_type: 'repair', manufacturer: 'BD' } as never)).toBe(true);
  expect(sameFilters({ report_type: 'repair' }, {})).toBe(false);
  expect(sameFilters({ report_type: 'repair' }, { report_type: 'preventive_maintenance' })).toBe(false);
  expect(sameFilters({ date_from: '2026-01-01' }, { date_from: '2026-01-02' })).toBe(false);
});

test('which criteria name a record that can be deleted', () => {
  expect(recordKeysOf({ report_type: 'repair' })).toEqual([]);
  expect(recordKeysOf({ instrument_id: 'i1', model_id: 'm1', place_id: 'p1', technician: 'x' })).toEqual(['instrument_id', 'model_id', 'place_id']);
  expect(recordKeysOf({ model_id: 'm1' })).toEqual(['model_id']);
});

test('goneKeys: only a checked kind whose id is missing is gone', () => {
  const filters = { instrument_id: 'i1', model_id: 'm1', place_id: 'p1' };
  expect(goneKeys(filters, { instrument_id: new Set(['i1']), model_id: new Set(['m1']), place_id: new Set(['p1']) })).toEqual([]);
  expect(goneKeys(filters, { instrument_id: new Set(['other']), model_id: new Set(['m1']), place_id: new Set() })).toEqual(['instrument_id', 'place_id']);
  // A kind that was not checked (nothing fetched for it) is never called gone.
  expect(goneKeys(filters, { model_id: new Set(['m1']) })).toEqual([]);
  // A criterion that is not set cannot be gone.
  expect(goneKeys({ report_type: 'repair' }, { instrument_id: new Set() })).toEqual([]);
});

test('the notice names what is gone, in a fixed order', () => {
  expect(goneNotice(['instrument_id'])).toBe('Your last search was cleared: the instrument it named no longer exists.');
  expect(goneNotice(['place_id', 'instrument_id'])).toBe('Your last search was cleared: the instrument and place it named no longer exists.');
  expect(goneNotice(['place_id', 'model_id', 'instrument_id'])).toBe(
    'Your last search was cleared: the instrument, model and place it named no longer exists.'
  );
});

test('a search is written and read back as it was', () => {
  writeKeptSearch({ text: 'repairs by zed', filters: { report_type: 'repair', technician: 'Zed' }, understood });
  expect(readKeptSearch()).toEqual({ text: 'repairs by zed', filters: { report_type: 'repair', technician: 'Zed' }, understood });
});

test('writing a new search replaces the old one', () => {
  writeKeptSearch({ text: 'first', filters: { report_type: 'repair' }, understood });
  writeKeptSearch({ text: 'second', filters: { status: 'in_review' }, understood: [] });
  expect(readKeptSearch()).toEqual({ text: 'second', filters: { status: 'in_review' }, understood: [] });
});

test('a search that sets nothing, or has no words, is not kept and removes the old one', () => {
  writeKeptSearch({ text: 'first', filters: { report_type: 'repair' }, understood });
  expect(readKeptSearch()).not.toBeNull();
  writeKeptSearch({ text: 'show me all reports', filters: {}, understood: [] });
  expect(readKeptSearch()).toBeNull();
  expect(storage.items.has(KEY)).toBe(false);

  writeKeptSearch({ text: 'first', filters: { report_type: 'repair' }, understood });
  writeKeptSearch({ text: '   ', filters: { report_type: 'repair' }, understood });
  expect(storage.items.has(KEY)).toBe(false);
});

test('clearing removes it', () => {
  writeKeptSearch({ text: 'first', filters: { report_type: 'repair' }, understood });
  clearKeptSearch();
  expect(readKeptSearch()).toBeNull();
});

test('unknown keys in a stored record are dropped on reading', () => {
  storage.setItem(KEY, JSON.stringify({ text: 'x', filters: { report_type: 'repair', manufacturer: 'BD', evil: '1' }, understood: [{ key: 'a', label: 'A', extra: 1 }] }));
  expect(readKeptSearch()).toEqual({ text: 'x', filters: { report_type: 'repair' }, understood: [{ key: 'a', label: 'A' }] });
});

test('a stored record that is not exactly ours reads as no search', () => {
  const bad: unknown[] = [
    'not json{',
    'null',
    '[]',
    '"text"',
    {},
    { text: 'x', filters: { report_type: 'repair' } }, // understood missing
    { text: 'x', filters: { report_type: 'repair' }, understood: 'Repair' },
    { text: 'x', filters: { report_type: 'repair' }, understood: [{ key: 'a' }] },
    { text: 'x', filters: { report_type: 'repair' }, understood: [null] },
    { text: 5, filters: { report_type: 'repair' }, understood },
    { text: '  ', filters: { report_type: 'repair' }, understood },
    { text: 'x', filters: [], understood },
    { text: 'x', filters: null, understood },
    { text: 'x', filters: {}, understood }, // nothing set: nothing to keep
    { text: 'x', filters: { report_type: 7 }, understood }, // not text, so left out, so nothing set
  ];
  for (const record of bad) {
    storage.setItem(KEY, typeof record === 'string' ? record : JSON.stringify(record));
    expect(readKeptSearch(), JSON.stringify(record)).toBeNull();
  }
});

test('storage that is missing or throws never breaks anything', () => {
  delete g.localStorage; // no storage at all
  expect(readKeptSearch()).toBeNull();
  expect(() => writeKeptSearch({ text: 'x', filters: { report_type: 'repair' }, understood })).not.toThrow();
  expect(() => clearKeptSearch()).not.toThrow();

  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('full');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  g.localStorage = throwing;
  expect(readKeptSearch()).toBeNull();
  expect(() => writeKeptSearch({ text: 'x', filters: { report_type: 'repair' }, understood })).not.toThrow();
  expect(() => clearKeptSearch()).not.toThrow();
});

// ---- The conditions shown as chips, and taking one out (part 2)

const kept = (filters: Record<string, string>, parts: { key: string; label: string }[]) => ({ text: 'a question', filters, understood: parts });

test('conditions: one chip per thing understood, in the order it was understood', () => {
  const search = kept({ report_type: 'repair', technician: 'Zed' }, understood);
  expect(conditionsOf(search)).toEqual(understood);
});

test('conditions: a date is one chip even though it sets two filters', () => {
  const search = kept({ date_from: '2025-01-01', date_to: '2025-12-31' }, [{ key: 'date', label: 'In 2025' }]);
  expect(conditionsOf(search)).toEqual([{ key: 'date', label: 'In 2025' }]);
});

test('conditions: a chip whose filter is gone is not shown, and a filter nobody named gets a plain chip', () => {
  // The question named a status, but only the type is left; and a lab manager filter has no chip of its own.
  const search = kept({ report_type: 'repair', technician: 'Zed Z' }, [
    { key: 'report_type', label: 'Repair' },
    { key: 'status', label: 'Status: Finalized' },
  ]);
  expect(conditionsOf(search)).toEqual([
    { key: 'report_type', label: 'Repair' },
    { key: 'technician', label: 'Lab manager: Zed Z' },
  ]);
  // An id that no chip names is shown by kind only, never as the raw id.
  const withId = kept({ instrument_id: '0f3a-secret-id', model_id: 'm1' }, []);
  expect(conditionsOf(withId).map((p) => p.label)).toEqual(['Instrument', 'Model']);
  expect(JSON.stringify(conditionsOf(withId))).not.toContain('0f3a');
  // A part that stands for no filter at all (a note) is never a chip.
  expect(conditionsOf(kept({ report_type: 'repair' }, [{ key: 'summary', label: 'A note' }, { key: 'report_type', label: 'Repair' }]))).toEqual([
    { key: 'report_type', label: 'Repair' },
  ]);
});

test('conditions: the same filter is never shown twice', () => {
  const search = kept({ report_type: 'repair' }, [
    { key: 'report_type', label: 'Repair' },
    { key: 'report_type', label: 'Repair (again)' },
  ]);
  expect(conditionsOf(search)).toEqual([{ key: 'report_type', label: 'Repair' }]);
});

test('removing one condition takes out its filter and nothing else', () => {
  const search = kept({ report_type: 'repair', technician: 'Zed' }, understood);
  expect(withoutCondition(search, 'report_type')).toEqual({
    text: 'a question',
    filters: { technician: 'Zed' },
    understood: [{ key: 'technician', label: 'Lab manager: Zed' }],
  });
  expect(withoutCondition(search, 'technician')?.filters).toEqual({ report_type: 'repair' });
  // The question stays as typed, and the search it came from is not changed.
  expect(withoutCondition(search, 'technician')?.text).toBe('a question');
  expect(search.filters).toEqual({ report_type: 'repair', technician: 'Zed' });
});

test('removing a date takes out both ends of it', () => {
  const search = kept({ report_type: 'repair', date_from: '2025-01-01', date_to: '2025-12-31' }, [
    { key: 'report_type', label: 'Repair' },
    { key: 'date', label: 'In 2025' },
  ]);
  expect(withoutCondition(search, 'date')?.filters).toEqual({ report_type: 'repair' });
});

test('a plain chip for an unnamed filter can be removed too', () => {
  const search = kept({ report_type: 'repair', status: 'draft' }, [{ key: 'report_type', label: 'Repair' }]);
  expect(withoutCondition(search, 'status')?.filters).toEqual({ report_type: 'repair' });
  // The two ends of a date nobody named are two chips, each removable on its own.
  const dates = kept({ date_from: '2025-01-01', date_to: '2025-02-01', status: 'draft' }, []);
  expect(conditionsOf(dates).map((p) => p.key)).toEqual(['status', 'date_from', 'date_to']);
  expect(withoutCondition(dates, 'date_from')?.filters).toEqual({ status: 'draft', date_to: '2025-02-01' });
});

test('removing the last condition leaves no search', () => {
  expect(withoutCondition(kept({ status: 'draft' }, [{ key: 'status', label: 'Status: Draft' }]), 'status')).toBeNull();
  expect(withoutCondition(kept({ date_from: '2025-01-01', date_to: '2025-12-31' }, [{ key: 'date', label: 'In 2025' }]), 'date')).toBeNull();
});

test('removing something that is not there changes nothing', () => {
  const search = kept({ report_type: 'repair' }, [{ key: 'report_type', label: 'Repair' }]);
  expect(withoutCondition(search, 'technician')).toEqual(search);
  expect(withoutCondition(search, 'not-a-filter')).toEqual(search);
});
