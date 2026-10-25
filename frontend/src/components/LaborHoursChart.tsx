import type { InstrumentRollup } from '../api';
import { HorizontalBarChart } from './HorizontalBarChart';

/** Work hours per instrument, most hours first, as horizontal bars. */

function hoursText(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

export function LaborHoursChart({ rows }: { rows: InstrumentRollup[] }) {
  const sorted = [...rows].sort((a, b) => b.total_labor_hours - a.total_labor_hours || a.name.localeCompare(b.name));
  return (
    <HorizontalBarChart
      testId="labor-chart"
      barClass="labor-bar"
      ariaLabel="Work hours per instrument"
      format={hoursText}
      items={sorted.map((r) => ({
        key: r.instrument_id,
        label: r.name,
        sub: [r.model !== r.name ? r.model : '', r.institution, r.serial_number].filter(Boolean).join(' · '),
        value: r.total_labor_hours,
        title: `${r.name}${r.institution ? ` · ${r.institution}` : ''} · ${r.model} · ${r.serial_number}: ${
          r.report_count === 0
            ? 'no hours recorded'
            : `${hoursText(r.total_labor_hours)} over ${r.report_count} report${r.report_count === 1 ? '' : 's'}`
        }`,
      }))}
    />
  );
}
