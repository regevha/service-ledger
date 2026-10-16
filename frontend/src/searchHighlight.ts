import type { ReportListItem, ReportTemplate } from './api';

// Client side of free-text search highlighting, used when a report is opened
// from search results. It mirrors the backend's excerpt logic
// (backend/app/services/report_search.py): the positive terms of the query,
// matched as whole words, case-insensitively.

/** The positive terms of a query: quoted phrases stay whole, `-excluded` words and `or` are dropped. */
export function queryTerms(q: string): string[] {
  const terms: string[] = [];
  for (const m of q.matchAll(/"([^"]+)"/g)) {
    const t = m[1].trim().toLowerCase();
    if (t) terms.push(t);
  }
  for (const raw of q.replace(/"[^"]*"/g, ' ').split(/\s+/)) {
    if (!raw || raw.startsWith('-') || raw.toLowerCase() === 'or') continue;
    const word = raw.replace(/^["'.,;:!?()[\]{}]+|["'.,;:!?()[\]{}]+$/g, '').toLowerCase();
    if (word) terms.push(word);
  }
  return terms;
}

export interface Piece {
  text: string;
  matched: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split `text` into pieces, marking the whole-word occurrences of the query's terms. */
export function highlightPieces(text: string, q: string): Piece[] {
  const terms = [...new Set(queryTerms(q))].sort((a, b) => b.length - a.length);
  if (terms.length === 0) return [{ text, matched: false }];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${terms.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > cursor) pieces.push({ text: text.slice(cursor, start), matched: false });
    pieces.push({ text: m[0], matched: true });
    cursor = start + m[0].length;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), matched: false });
  return pieces;
}

export interface SearchableSegment {
  label: string;
  text: string;
}

function labelOf(name: string): string {
  const s = name.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The searchable text of a report, as the backend indexes it: instrument model and serial, the template's text fields, and the text cells of its tables. */
export function searchableSegments(
  template: ReportTemplate,
  fields: Record<string, unknown>,
  item: Pick<ReportListItem, 'instrument_model' | 'instrument_serial_number'>
): SearchableSegment[] {
  const out: SearchableSegment[] = [];
  if (item.instrument_model) out.push({ label: 'Instrument model', text: item.instrument_model });
  if (item.instrument_serial_number) out.push({ label: 'Instrument serial number', text: item.instrument_serial_number });
  for (const field of template.field_schema.fields) {
    const value = fields[field.name];
    if (field.type === 'text' && typeof value === 'string' && value.trim()) {
      out.push({ label: labelOf(field.name), text: value.trim() });
    } else if (field.type === 'object[]' && Array.isArray(value)) {
      const textColumns = (field.item_schema ?? []).filter((c) => c.type === 'text').map((c) => c.name);
      for (const row of value) {
        if (typeof row !== 'object' || row === null) continue;
        for (const column of textColumns) {
          const cell = (row as Record<string, unknown>)[column];
          if (typeof cell === 'string' && cell.trim()) out.push({ label: labelOf(field.name), text: cell.trim() });
        }
      }
    }
  }
  return out;
}
