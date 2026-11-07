import type { FieldType, PageWord } from './api';

// The pure parts of picking template fields from a PDF page: which words a click or a dragged box
// covers, what the new field could be called, and what type its sample text looks like. Everything
// here works on fractions of the page (0 to 1 from the top left), the same units the server returns.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The type choices the picker offers; the field editor below it has the rest (choices, tables, per-detector numbers). */
export const PICKER_TYPES: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes / No' },
];

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Indexes of the words a dragged box touches, in reading order (top to bottom, then left to right). */
export function wordsInBox(words: PageWord[], box: Box): number[] {
  return words
    .map((word, index) => ({ word, index }))
    .filter(({ word }) => overlaps(word, box))
    .sort((a, b) => a.word.line - b.word.line || a.word.x - b.word.x)
    .map(({ index }) => index);
}

/** The word under a point, or null. A point on the gap between two words picks nothing. */
export function wordAt(words: PageWord[], x: number, y: number): number | null {
  const hit = words.findIndex((w) => x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h);
  return hit < 0 ? null : hit;
}

/** Every word on the same line as `index`, in reading order. */
export function wordsOnLine(words: PageWord[], index: number): number[] {
  const line = words[index]?.line;
  if (line === undefined) return [];
  return words
    .map((word, i) => ({ word, i }))
    .filter(({ word }) => word.line === line)
    .sort((a, b) => a.word.x - b.word.x)
    .map(({ i }) => i);
}

/** The text of the chosen words, joined the way they read: a space within a line, a line break between lines. */
export function selectedText(words: PageWord[], indexes: number[]): string {
  let out = '';
  let previousLine: number | null = null;
  for (const i of indexes) {
    const word = words[i];
    if (!word) continue;
    if (previousLine !== null) out += word.line === previousLine ? ' ' : '\n';
    out += word.text;
    previousLine = word.line;
  }
  return out;
}

/** The box around the chosen words, or null when none are chosen. */
export function boundsOf(words: PageWord[], indexes: number[]): Box | null {
  const chosen = indexes.map((i) => words[i]).filter(Boolean);
  if (chosen.length === 0) return null;
  const x1 = Math.min(...chosen.map((w) => w.x));
  const y1 = Math.min(...chosen.map((w) => w.y));
  const x2 = Math.max(...chosen.map((w) => w.x + w.w));
  const y2 = Math.max(...chosen.map((w) => w.y + w.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

const DATE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;
const NUMBER = /^[-+]?\d+(?:[.,]\d+)?$/;
const YES_NO = /^(yes|no|pass|fail|ok|y|n)$/i;

/** The field type the sample text looks like: a date, a number, a yes/no word, otherwise text. */
export function guessType(sample: string): FieldType {
  const text = sample.trim();
  if (DATE.test(text)) return 'date';
  if (NUMBER.test(text)) return 'number';
  if (YES_NO.test(text)) return 'boolean';
  return 'text';
}

// Gap, as a fraction of the page width, wider than which two words on a line are in different columns.
const COLUMN_GAP = 0.06;
const MAX_LABEL_WORDS = 4;

/**
 * The words printed just before the chosen ones on the same line, the way a form puts a label before its
 * value ("Laser delay" before "29.40"). It stops at a column gap, at a word with a digit in it (that is
 * another value, not a label) and after four words. Empty when the chosen words start the line.
 */
export function labelBefore(words: PageWord[], indexes: number[]): string {
  if (indexes.length === 0) return '';
  const first = words[indexes[0]];
  if (!first) return '';
  const left = wordsOnLine(words, indexes[0]).filter((i) => words[i].x < first.x && !indexes.includes(i));
  const picked: string[] = [];
  let edge = first.x;
  for (const i of [...left].reverse()) {
    const word = words[i];
    if (edge - (word.x + word.w) > COLUMN_GAP) break;
    if (/\d/.test(word.text)) break;
    picked.unshift(word.text);
    edge = word.x;
    if (picked.length >= MAX_LABEL_WORDS || /:$/.test(word.text)) break;
  }
  return picked.join(' ').replace(/[:\s]+$/, '').trim();
}

/** "Laser delay:" becomes "laser_delay": lower case, words joined by underscores, nothing else. */
export function toFieldName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/**
 * A name for a new field that no existing field has: the label before the chosen words, else the chosen
 * words themselves when they are text, else "field"; a number is added when the name is taken.
 */
export function suggestFieldName(words: PageWord[], indexes: number[], taken: string[]): string {
  const sample = selectedText(words, indexes);
  const label = labelBefore(words, indexes);
  let base = toFieldName(label);
  if (!base && guessType(sample) === 'text') base = toFieldName(sample.split(/\s+/).slice(0, 3).join(' '));
  if (!base) base = 'field';
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
  }
}

/** The hint stored with the field so the reader knows where to look: the label and the page. */
export function suggestNotes(label: string, page: number): string {
  return label ? `Printed next to "${label}" on page ${page}.` : `Printed on page ${page}.`;
}
