import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';

/**
 * Reads CSV text the way RFC 4180 describes it: fields separated by commas, rows by line breaks, a field
 * that holds a comma, a quote or a line break wrapped in quotes with its own quotes doubled. A plain
 * split on commas would pass or fail a file for the wrong reason as soon as a value contains one.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error('The CSV ends inside a quoted field.');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export type DownloadedCsv = {
  filename: string;
  header: string[];
  /** Each data row, keyed by the header. Throws if a row does not have as many fields as the header. */
  rows: Record<string, string>[];
};

/** Clicks a download link and reads the file it saves. */
export async function downloadCsv(page: Page, link: Locator): Promise<DownloadedCsv> {
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  const path = await download.path();
  if (!path) throw new Error('The download was not saved.');
  const [header = [], ...data] = parseCsv(await readFile(path, 'utf8'));
  const rows = data.map((fields, n) => {
    if (fields.length !== header.length) throw new Error(`CSV row ${n + 1} has ${fields.length} fields, the header has ${header.length}.`);
    return Object.fromEntries(header.map((name, i) => [name, fields[i]]));
  });
  return { filename: download.suggestedFilename(), header, rows };
}
