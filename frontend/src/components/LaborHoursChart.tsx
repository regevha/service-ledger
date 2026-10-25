import type { InstrumentRollup } from '../api';
import { ColumnChart } from './ColumnChart';

/** Work hours per instrument, most hours first, as a column chart. */

function hoursText(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

export function LaborHoursChart({ rows }: { rows: InstrumentRollup[] }) {
  const sorted = [...rows].sort((a, b) => b.total_labor_hours - a.total_labor_hours || a.name.localeCompare(b.name));
  return (
    <ColumnChart
      testId="labor-chart"
      ariaLabel={`Work hours per instrument: ${sorted.map((r) => `${r.name} ${hoursText(r.total_labor_hours)}`).join(', ')}`}
      format={hoursText}
      items={sorted.map((r) => ({
        key: r.instrument_id,
        name: r.name,
        sub: r.institution ?? (r.model !== r.name ? r.model : ''),
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
