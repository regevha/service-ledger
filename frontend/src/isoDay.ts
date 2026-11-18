const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar day written as YYYY-MM-DD. */
export function isIsoDay(text: string): boolean {
  const m = ISO_DAY.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Format a valid date-only value without applying a timezone. */
export function formatIsoDay(text: string): string {
  return isIsoDay(text) ? `${text.slice(8, 10)}/${text.slice(5, 7)}/${text.slice(0, 4)}` : text;
}

/** Parse the displayed day-first date into the API's ISO date-only format. */
export function parseDisplayDay(text: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  return isIsoDay(iso) ? iso : null;
}
