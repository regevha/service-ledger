import type { Instrument, ReportListItem } from './api';

// The pure parts of the Today screen: which instruments are due and how to say so, and which reports wait.

/** Whole days from `today` to the ISO day `iso` (negative when it has passed). Both are read as local days. */
export function daysUntil(iso: string, today: Date): number {
  const [y, m, d] = iso.split('-').map(Number);
  const due = Date.UTC(y, m - 1, d);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((due - now) / 86_400_000);
}

/** "3 days over", "due today", "in 9 days" (and the singular forms). */
export function dueText(days: number): string {
  if (days === 0) return 'due today';
  const n = Math.abs(days);
  const unit = n === 1 ? 'day' : 'days';
  return days < 0 ? `${n} ${unit} over` : `in ${n} ${unit}`;
}

export interface MaintenanceItem {
  id: string;
  label: string;
  place: string | null;
  dueDate: string;
  days: number;
  overdue: boolean;
}

/** The instrument line used everywhere on this screen: "FACSAria III · P69200123". */
export function instrumentLabel(model: string | null | undefined, serial: string | null | undefined): string {
  const parts = [model, serial].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' · ') : 'Instrument not identified';
}

/**
 * The instruments whose maintenance is overdue or coming up, the most overdue first. An instrument counts
 * only when the app tracks it (an overdue or due-soon state with a due date); retired ones never do.
 */
export function maintenanceItems(instruments: Instrument[], today: Date): MaintenanceItem[] {
  return instruments
    .filter((i) => (i.maintenance_state === 'overdue' || i.maintenance_state === 'due_soon') && Boolean(i.maintenance_due_date))
    .map((i) => {
      const dueDate = i.maintenance_due_date as string;
      const days = daysUntil(dueDate, today);
      return {
        id: i.id,
        label: instrumentLabel(i.model, i.serial_number),
        place: i.location ?? null,
        dueDate,
        days,
        overdue: i.maintenance_state === 'overdue',
      };
    })
    .sort((a, b) => a.days - b.days || a.label.localeCompare(b.label));
}

/** The first day of `today`'s month as an ISO day. */
export function monthStart(today: Date): string {
  const m = String(today.getMonth() + 1).padStart(2, '0');
  return `${today.getFullYear()}-${m}-01`;
}

/**
 * The reports waiting for a person: read but not finalized. Newest first; a report whose service date is
 * unknown goes by when it was uploaded.
 */
export function waitingReports(extracted: ReportListItem[], inReview: ReportListItem[]): ReportListItem[] {
  const key = (r: ReportListItem) => r.created_at;
  return [...extracted, ...inReview].sort((a, b) => key(b).localeCompare(key(a)));
}
