import type { MaintenanceState } from '../api';
import { MAINTENANCE_STATE_LABEL } from '../labels';

function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The maintenance state of an instrument as a small pill. The due date, when
 *  there is one, is in the tooltip and, for the states that need action, in the
 *  text itself. Renders nothing for a retired instrument (state is null). */
export function MaintenanceBadge({ state, dueDate }: { state?: MaintenanceState | null; dueDate?: string | null }) {
  if (!state) return null;
  const label = MAINTENANCE_STATE_LABEL[state];
  const due = dueDate ? formatDay(dueDate) : null;
  const text = due && (state === 'overdue' || state === 'due_soon') ? `${label} · ${due}` : label;
  return (
    <span className={`status-pill maintenance-${state}`} title={due ? `Next maintenance due ${due}` : label}>
      {text}
    </span>
  );
}
