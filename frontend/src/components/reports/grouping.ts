import type { Instrument, ReportListItem } from '../../api';

export type GroupMode = 'instrument' | 'model' | 'none';
export const GROUP_KEY = 'sl.reports.group';

// Per-viewer convenience only: browser storage can be empty or throw.
export function readGroupMode(): GroupMode {
  try {
    const saved = localStorage.getItem(GROUP_KEY);
    return saved === 'none' || saved === 'model' ? saved : 'instrument';
  } catch {
    return 'instrument';
  }
}
export function writeGroupMode(mode: GroupMode) {
  try {
    localStorage.setItem(GROUP_KEY, mode);
  } catch {
    /* not remembered; nothing else depends on it */
  }
}

/** Reports of one instrument or one model (or of the uploads that have no instrument yet), newest first. */
export interface ReportGroup {
  key: string;
  title: string;
  serial: string | null;
  instrument: Instrument | null;
  items: ReportListItem[];
  needsReview: number;
  /** Model groups only: the manufacturer, and how many different units the reports are about. */
  maker?: string | null;
  units?: number;
  /** Model groups only: the known instruments behind those units, by serial number, for a Trend link each. */
  unitInstruments?: Instrument[];
}

export const NOT_READ_KEY = 'unread';

/** Newest report first inside each group; the group holding the newest report leads and "Not read yet" is last. */
export function sortGroups(groups: ReportGroup[]): ReportGroup[] {
  const newest = (g: ReportGroup) => g.items.reduce((m, r) => (r.created_at > m ? r.created_at : m), '');
  return [...groups].sort((a, b) => (a.key === NOT_READ_KEY ? 1 : b.key === NOT_READ_KEY ? -1 : newest(b).localeCompare(newest(a))));
}

export function groupByInstrument(items: ReportListItem[], instruments: Instrument[]): ReportGroup[] {
  const byKey = new Map<string, ReportGroup>();
  for (const r of items) {
    const key = r.instrument_model || r.instrument_serial_number ? `${r.instrument_model ?? ''}|${r.instrument_serial_number ?? ''}` : NOT_READ_KEY;
    let g = byKey.get(key);
    if (!g) {
      const instrument = instruments.find((i) => i.model === r.instrument_model && i.serial_number === r.instrument_serial_number) ?? null;
      g = {
        key,
        title: key === NOT_READ_KEY ? 'Not read yet' : (r.instrument_model ?? 'Unknown instrument'),
        serial: r.instrument_serial_number,
        instrument,
        items: [],
        needsReview: 0,
      };
      byKey.set(key, g);
    }
    g.items.push(r);
    if (r.status === 'in_review' || r.status === 'extracted') g.needsReview += 1;
  }
  // Instruments with the most recent report first; "Not read yet" last.
  return sortGroups([...byKey.values()]);
}

/** One group per instrument model, however many units of it there are; the rows say which unit by serial number. */
export function groupByModel(items: ReportListItem[], instruments: Instrument[]): ReportGroup[] {
  const byKey = new Map<string, ReportGroup>();
  const serials = new Map<string, Set<string>>();
  const unitsByKey = new Map<string, Map<string, Instrument>>();
  for (const r of items) {
    const key = r.instrument_model ? `model|${r.instrument_model}` : r.instrument_serial_number ? 'model|' : NOT_READ_KEY;
    let g = byKey.get(key);
    if (!g) {
      const known = r.instrument_model ? instruments.find((i) => i.model === r.instrument_model) : undefined;
      g = {
        key,
        title: key === NOT_READ_KEY ? 'Not read yet' : (r.instrument_model ?? 'Unknown model'),
        serial: null,
        instrument: null,
        items: [],
        needsReview: 0,
        maker: known?.manufacturer ?? null,
        units: 0,
      };
      byKey.set(key, g);
      serials.set(key, new Set());
      unitsByKey.set(key, new Map());
    }
    g.items.push(r);
    if (r.instrument_serial_number) {
      serials.get(key)!.add(r.instrument_serial_number);
      const unit = instruments.find((i) => i.model === r.instrument_model && i.serial_number === r.instrument_serial_number);
      if (unit) unitsByKey.get(key)!.set(unit.serial_number, unit);
    }
    if (r.status === 'in_review' || r.status === 'extracted') g.needsReview += 1;
  }
  for (const [key, g] of byKey) {
    g.units = serials.get(key)!.size;
    g.unitInstruments = [...unitsByKey.get(key)!.values()].sort((a, b) => a.serial_number.localeCompare(b.serial_number));
  }
  return sortGroups([...byKey.values()]);
}

/** An upload that was never classified: it has no instrument or type to show yet. */
export function isUnread(r: ReportListItem): boolean {
  return r.status !== 'finalized' && !r.instrument_model && !r.report_type;
}
