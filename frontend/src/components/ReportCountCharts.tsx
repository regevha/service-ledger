import type { ReportCountByInstrument, ReportCountByModel } from '../api';
import { ColumnChart } from './ColumnChart';

/** Number of reports per instrument and per instrument model, as column charts, most reports first. */

const count = (n: number) => String(n);
const reportsText = (n: number) => `${n} report${n === 1 ? '' : 's'}`;

export function ReportsPerInstrumentChart({ rows }: { rows: ReportCountByInstrument[] }) {
  const sorted = [...rows].sort((a, b) => b.report_count - a.report_count || a.name.localeCompare(b.name));
  return (
    <ColumnChart
      testId="reports-per-instrument-chart"
      barClass="count-bar"
      wholeNumbers
      format={count}
      ariaLabel={`Reports per instrument: ${sorted.map((r) => `${r.name} ${r.report_count}`).join(', ')}`}
      items={sorted.map((r) => ({
        key: r.instrument_id,
        name: r.name,
        sub: r.institution ?? (r.model !== r.name ? r.model : ''),
        value: r.report_count,
        title: `${r.name}${r.institution ? ` · ${r.institution}` : ''} · ${r.model} · ${r.serial_number}: ${reportsText(r.report_count)}`,
      }))}
    />
  );
}

export function ReportsPerModelChart({ rows }: { rows: ReportCountByModel[] }) {
  const sorted = [...rows].sort((a, b) => b.report_count - a.report_count || a.model.localeCompare(b.model));
  return (
    <ColumnChart
      testId="reports-per-model-chart"
      barClass="count-bar"
      wholeNumbers
      format={count}
      ariaLabel={`Reports per instrument model: ${sorted.map((r) => `${r.model} ${r.report_count}`).join(', ')}`}
      items={sorted.map((r) => ({
        key: r.model,
        name: r.model,
        sub: `${r.unit_count} unit${r.unit_count === 1 ? '' : 's'}`,
        value: r.report_count,
        title: `${r.model} (${r.unit_count} unit${r.unit_count === 1 ? '' : 's'}): ${reportsText(r.report_count)}`,
      }))}
    />
  );
}
