/**
 * The last few questions the person asked in plain words, kept in the browser so one can be asked again with a
 * tap (on a phone that beats typing). Only the question is stored: asking it again reads it afresh, so a
 * recent search never points at an instrument or place that has since been deleted.
 *
 * Browser storage can be empty, full, blocked or hold something old or edited by hand, so every read is guarded
 * and checked, and a failed write is ignored.
 */
const STORAGE_KEY = 'sl.ask.recent';
export const RECENT_MAX = 5;
const MAX_TEXT = 300;

/** `text` first, the same question typed before (any case) removed, at most RECENT_MAX kept. */
export function addRecent(list: readonly string[], text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [...list];
  const rest = list.filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
  return [trimmed, ...rest].slice(0, RECENT_MAX);
}

/** Whatever the stored value is, only non-empty strings of a sane length survive, without repeats. */
export function cleanRecent(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || text.length > MAX_TEXT) continue;
    if (out.some((seen) => seen.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
  }
  return out.slice(0, RECENT_MAX);
}

export function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? cleanRecent(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function writeRecent(list: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    // Storage full or blocked: the recent list simply is not kept.
  }
}
