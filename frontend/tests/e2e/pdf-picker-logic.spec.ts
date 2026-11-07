import { test, expect } from './coverage';
import type { PageWord } from '../../src/api';
import { boundsOf, guessType, labelBefore, selectedText, suggestFieldName, suggestNotes, toFieldName, wordAt, wordsInBox, wordsOnLine } from '../../src/pdfPicker';
import { dueText, daysUntil, maintenanceItems, monthStart, waitingReports } from '../../src/home';

// Pure logic behind the PDF field picker and the Home screen; no browser needed.

const w = (text: string, x: number, line: number): PageWord => ({ text, x, y: 0.1 * line, w: 0.05 * Math.max(text.length, 1) / 3, h: 0.02, line });
const words: PageWord[] = [w('Laser', 0.1, 1), w('delay', 0.18, 1), w('29.40', 0.3, 1), w('Sheath', 0.1, 2), w('pressure', 0.2, 2), w('4.9', 0.35, 2), w('psi', 0.4, 2)];

test('picker: selection helpers', () => {
  expect(wordAt(words, words[2].x + 0.001, words[2].y + 0.001)).toBe(2);
  expect(wordAt(words, 0.9, 0.9)).toBeNull();
  expect(wordsOnLine(words, 4)).toEqual([3, 4, 5, 6]);
  expect(selectedText(words, [0, 1, 2, 3])).toBe('Laser delay 29.40\nSheath');
  const box = boundsOf(words, [3, 4])!;
  expect(wordsInBox(words, box)).toEqual([3, 4]);
  expect(boundsOf(words, [])).toBeNull();
});

test('picker: names, types and notes', () => {
  expect(labelBefore(words, [2])).toBe('Laser delay');
  expect(labelBefore(words, [0])).toBe('');
  expect(suggestFieldName(words, [2], [])).toBe('laser_delay');
  expect(suggestFieldName(words, [2], ['laser_delay'])).toBe('laser_delay_2');
  expect(toFieldName('  Laser delay: ')).toBe('laser_delay');
  expect(guessType('29.40')).toBe('number');
  expect(guessType('2026-10-01')).toBe('date');
  expect(guessType('Pass')).toBe('boolean');
  expect(guessType('hello')).toBe('text');
  expect(suggestNotes('Laser delay', 2)).toBe('Printed next to "Laser delay" on page 2.');
  expect(suggestNotes('', 1)).toBe('Printed on page 1.');
});

test('home: due text, month start, ordering', () => {
  const now = new Date(2026, 10, 6);
  expect(daysUntil('2026-11-09', now)).toBe(3);
  expect(dueText(-3)).toBe('3 days over');
  expect(dueText(0)).toBe('due today');
  expect(dueText(1)).toBe('in 1 day');
  expect(monthStart(now)).toBe('2026-11-01');
  const inst = (id: string, state: string, due: string | null) => ({ id, model: id, serial_number: null, location: null, maintenance_state: state, maintenance_due_date: due }) as never;
  const items = maintenanceItems([inst('B', 'due_soon', '2026-11-10'), inst('A', 'overdue', '2026-11-01'), inst('C', 'ok', '2027-01-01'), inst('D', 'overdue', null)], now);
  expect(items.map((i) => i.id)).toEqual(['A', 'B']);
  const r = (id: string, created_at: string) => ({ id, created_at }) as never;
  expect(waitingReports([r('1', '2026-11-01')], [r('2', '2026-11-03')]).map((x: { id: string }) => x.id)).toEqual(['2', '1']);
});
