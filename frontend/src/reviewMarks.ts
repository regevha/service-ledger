// What the review screen draws on the document: one mark per field, coloured by how much it needs a person.

export type FieldMark = 'ok' | 'flag' | 'changed';

/** Two field values are the same when they hold the same thing (text is compared without surrounding spaces). */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim() : v === undefined ? null : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** "changed" wins (the person has touched it), then "flag" (still needs a look), else "ok". */
export function markFor(changed: boolean, flagged: boolean): FieldMark {
  return changed ? 'changed' : flagged ? 'flag' : 'ok';
}

export const MARK_LABEL: Record<FieldMark, string> = {
  ok: 'Read with confidence',
  flag: 'Needs a check',
  changed: 'You changed it',
};
