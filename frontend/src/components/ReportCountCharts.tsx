import type { ReportCountByInstrument, ReportCountByModel } from '../api';
import { HorizontalBarChart } from './HorizontalBarChart';

/** Number of reports per instrument and per instrument model, as column charts, most reports first. */

const count = (n: number) => String(n);
const reportsText = (n: number) => `${n} report${n === 1 ? '' : 's'}`;

export function ReportsPerInstrumentChart({ rows }: { rows: ReportCountByInstrument[] }) {
  const sorted = [...rows].sort((a, b) => b.report_count - a.report_count || a.name.localeCompare(b.name));
  return (
    <HorizontalBarChart
      testId="reports-per-instrument-chart"
      barClass="count-bar"
      format={count}
      ariaLabel="Reports per instrument"
      items={sorted.map((r) => ({
        key: r.instrument_id,
        label: r.name,
        sub: [r.model !== r.name ? r.model : '', r.institution, r.serial_number].filter(Boolean).join(' · '),
        value: r.report_count,
        title: `${r.name}${r.institution ? ` · ${r.institution}` : ''} · ${r.model} · ${r.serial_number}: ${reportsText(r.report_count)}`,
      }))}
    />
  );
}

export function ReportsPerModelChart({ rows }: { rows: ReportCountByModel[] }) {
  const sorted = [...rows].sort((a, b) => b.report_count - a.report_count || a.model.localeCompare(b.model));
  return (
    <HorizontalBarChart
      testId="reports-per-model-chart"
      barClass="count-bar"
      format={count}
      ariaLabel="Reports per instrument model"
      items={sorted.map((r) => ({
        key: r.model,
        label: r.model,
        sub: `${r.unit_count} unit${r.unit_count === 1 ? '' : 's'}`,
        value: r.report_count,
        title: `${r.model} (${r.unit_count} unit${r.unit_count === 1 ? '' : 's'}): ${reportsText(r.report_count)}`,
      }))}
    />
  );
}
