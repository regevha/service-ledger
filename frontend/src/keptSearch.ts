import type { ReportFilters, ReportSearchPart } from './api';

/**
 * The last search the person asked for in plain words ("repairs of the FACSAria III last month"), kept in the
 * browser so it survives closing a screen, moving between tabs and a reload, until the person changes it.
 *
 * It holds the question, the filters the server turned it into, and what was understood from it. Reports,
 * Analytics and the Ask box all read the same record, so they cannot disagree about what is in force.
 *
 * Browser storage can be empty, full, blocked or hold something old or edited by hand, so every read is guarded
 * and checked; a record that is not exactly this shape is treated as no search at all.
 */
export interface KeptSearch {
  /** The question as typed. */
  text: string;
  /** The filters it was turned into; only criteria that were set. */
  filters: ReportFilters;
  /** What was understood from it, one entry per condition. */
  understood: ReportSearchPart[];
}

const STORAGE_KEY = 'sl.ask.kept';

/** Every criterion a search can set. Anything else in a stored record is ignored. */
const FILTER_KEYS = ['instrument_id', 'model_id', 'place_id', 'report_type', 'status', 'date_from', 'date_to', 'technician', 'q'] as const;

/** The criteria that point at a record that can be deleted later. */
export const GONE_KEYS = ['instrument_id', 'model_id', 'place_id'] as const;
export type GoneKey = (typeof GONE_KEYS)[number];

/** Only the known criteria, with empty values dropped, so two filter objects compare by what they say. */
export function criteriaOf(filters: ReportFilters): ReportFilters {
  const out: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = (filters as Record<string, unknown>)[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out as ReportFilters;
}

/** True when both say the same: an unset criterion and an empty one count as the same. */
export function sameFilters(a: ReportFilters, b: ReportFilters): boolean {
  const ca = criteriaOf(a);
  const cb = criteriaOf(b);
  return FILTER_KEYS.every((key) => (ca[key] ?? '') === (cb[key] ?? ''));
}

export function hasCriteria(filters: ReportFilters): boolean {
  return Object.keys(criteriaOf(filters)).length > 0;
}

/** Which of the criteria point at an instrument, a model or a place (the ones that can go stale). */
export function recordKeysOf(filters: ReportFilters): GoneKey[] {
  const criteria = criteriaOf(filters);
  return GONE_KEYS.filter((key) => Boolean(criteria[key]));
}

/** The keys whose id is not among the ids that still exist. `existing` lists only the kinds that were checked. */
export function goneKeys(filters: ReportFilters, existing: Partial<Record<GoneKey, ReadonlySet<string>>>): GoneKey[] {
  const criteria = criteriaOf(filters);
  return GONE_KEYS.filter((key) => {
    const ids = existing[key];
    const id = criteria[key];
    return Boolean(id) && ids !== undefined && !ids.has(id as string);
  });
}

const KIND_WORD: Record<GoneKey, string> = { instrument_id: 'instrument', model_id: 'model', place_id: 'place' };

/** "Your last search was cleared: the instrument it named no longer exists." */
export function goneNotice(keys: readonly GoneKey[]): string {
  const words = GONE_KEYS.filter((key) => keys.includes(key)).map((key) => KIND_WORD[key]);
  const named = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0];
  return `Your last search was cleared: the ${named} it named no longer exists.`;
}

type FilterKey = (typeof FILTER_KEYS)[number];

/** The filters one condition (one chip) stands for. "date" is the one condition that sets two. */
function filtersOfCondition(key: string): FilterKey[] {
  if (key === 'date') return ['date_from', 'date_to'];
  return (FILTER_KEYS as readonly string[]).includes(key) ? [key as FilterKey] : [];
}

const FALLBACK_LABEL: Record<FilterKey, string> = {
  instrument_id: 'Instrument',
  model_id: 'Model',
  place_id: 'Place',
  report_type: 'Type',
  status: 'Status',
  date_from: 'From',
  date_to: 'To',
  technician: 'Lab manager',
  q: 'Text',
};

/**
 * The conditions to show as chips: what was understood from the question, limited to what still filters, and, for
 * anything that filters without having been named, a plain chip of its own, so no filter in force is ever hidden
 * (and every one can be removed).
 */
export function conditionsOf(search: KeptSearch): ReportSearchPart[] {
  const criteria = criteriaOf(search.filters);
  const covered = new Set<FilterKey>();
  const parts: ReportSearchPart[] = [];
  for (const part of search.understood) {
    const keys = filtersOfCondition(part.key).filter((key) => criteria[key]);
    if (keys.length === 0 || keys.every((key) => covered.has(key))) continue;
    keys.forEach((key) => covered.add(key));
    parts.push(part);
  }
  for (const key of FILTER_KEYS) {
    if (!criteria[key] || covered.has(key)) continue;
    parts.push({ key, label: key.endsWith('_id') ? FALLBACK_LABEL[key] : `${FALLBACK_LABEL[key]}: ${criteria[key]}` });
  }
  return parts;
}

/** This search without one condition, or null when that was the last one (then nothing is left to keep). */
export function withoutCondition(search: KeptSearch, key: string): KeptSearch | null {
  const filters: Record<string, string> = { ...criteriaOf(search.filters) };
  for (const filter of filtersOfCondition(key)) delete filters[filter];
  if (!hasCriteria(filters as ReportFilters)) return null;
  return { text: search.text, filters: filters as ReportFilters, understood: search.understood.filter((part) => part.key !== key) };
}

function isParts(value: unknown): value is ReportSearchPart[] {
  return (
    Array.isArray(value) &&
    value.every(
      (part) => typeof part === 'object' && part !== null && typeof (part as ReportSearchPart).key === 'string' && typeof (part as ReportSearchPart).label === 'string'
    )
  );
}

/** What is kept, or null when nothing is, the storage is unavailable, or the record is not one of ours. */
export function readKeptSearch(): KeptSearch | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.text !== 'string' || !record.text.trim()) return null;
    if (typeof record.filters !== 'object' || record.filters === null || Array.isArray(record.filters)) return null;
    if (!isParts(record.understood)) return null;
    const filters = criteriaOf(record.filters as ReportFilters);
    // A search that sets nothing narrows nothing, so there is nothing to keep.
    if (!hasCriteria(filters)) return null;
    return { text: record.text, filters, understood: record.understood.map(({ key, label }) => ({ key, label })) };
  } catch {
    return null;
  }
}

/** Keeps this search, replacing any earlier one. A search that sets no criterion is not kept (the old one goes). */
export function writeKeptSearch(search: KeptSearch): void {
  const filters = criteriaOf(search.filters);
  if (!search.text.trim() || !hasCriteria(filters)) {
    clearKeptSearch();
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ text: search.text, filters, understood: search.understood }));
  } catch {
    /* not kept; the search still applies on this screen */
  }
}

export function clearKeptSearch(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}
