import { useState } from 'react';
import { getFleetAnalytics, type FleetAnalytics, type InstrumentRollup, type PartUsage } from '../api';
import { useAsyncEffect } from '../hooks/useAsyncEffect';
import { REPORT_TYPE_LABEL } from '../labels';
import { ModelComparisonSection } from './ModelComparison';

/**
 * Fleet-wide roll-ups (GET /analytics/fleet) — most-replaced parts, labor
 * hours by instrument and by fault category, and pass/fail rates for repair
 * and preventive_maintenance reports. See backend/app/services/analytics.py
 * for exactly how each number is derived; this component only renders what
 * that endpoint already computed, no client-side aggregation.
 *
 * Bar charts here are hand-rolled flex/width bars rather than a charting
 * library — this app has none, and a handful of magnitude comparisons (a
 * dozen parts, three instruments, four fault categories) don't need one.
 * Every value is also rendered as text alongside its bar, so the data is
 * never encoded in bar length alone.
 */

const TOP_PARTS_LIMIT = 8;

function formatHours(hours: number): string {
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`;
}

function BarRow({ label, sublabel, value, maxValue, formattedValue }: {
  label: string;
  sublabel?: string;
  value: number;
  maxValue: number;
  formattedValue: string;
}) {
  const pct = maxValue > 0 ? Math.max((value / maxValue) * 100, value > 0 ? 2 : 0) : 0;
  return (
    <div className="bar-row">
      <div className="bar-row-label">
        <span className="bar-label">{label}</span>
        {sublabel && <span className="bar-sublabel">{sublabel}</span>}
      </div>
      <div className="bar-track" title={`${label}: ${formattedValue}`}>
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="bar-value">{formattedValue}</span>
    </div>
  );
}

function PartsChart({ parts }: { parts: PartUsage[] }) {
  if (parts.length === 0) {
    return <div className="empty-hint">No parts recorded on any finalized report yet.</div>;
  }
  const top = parts.slice(0, TOP_PARTS_LIMIT);
  const maxQty = Math.max(...top.map((p) => p.total_qty));
  return (
    <>
      <div className="bar-chart">
        {top.map((p) => (
          <BarRow
            key={`${p.part_name}-${p.part_number ?? ''}`}
            label={p.part_name}
            sublabel={p.part_number ? `#${p.part_number}` : undefined}
            value={p.total_qty}
            maxValue={maxQty}
            formattedValue={`${p.total_qty} unit${p.total_qty === 1 ? '' : 's'} · ${p.times_replaced} report${p.times_replaced === 1 ? '' : 's'}`}
          />
        ))}
      </div>
      {parts.length > TOP_PARTS_LIMIT && (
        <div className="hint-text chart-footnote">
          Showing the top {TOP_PARTS_LIMIT} of {parts.length} distinct parts, by units replaced.
        </div>
      )}
    </>
  );
}

function LaborHoursByInstrumentChart({ rows }: { rows: InstrumentRollup[] }) {
  const maxHours = Math.max(...rows.map((r) => r.total_labor_hours), 0);
  return (
    <div className="bar-chart">
      {rows.map((r) => (
        <BarRow
          key={r.instrument_id}
          label={r.model}
          sublabel={r.serial_number}
          value={r.total_labor_hours}
          maxValue={maxHours}
          formattedValue={
            r.report_count === 0 ? 'No repair/PM reports yet' : `${formatHours(r.total_labor_hours)} · ${r.report_count} report${r.report_count === 1 ? '' : 's'}`
          }
        />
      ))}
    </div>
  );
}

function LaborHoursByFaultCategoryChart({ byCategory }: { byCategory: Record<string, number> }) {
  const entries = Object.entries(byCategory).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) {
    return <div className="empty-hint">No repair reports with both labor hours and a fault category yet.</div>;
  }
  const maxHours = Math.max(...entries.map(([, hours]) => hours));
  return (
    <div className="bar-chart">
      {entries.map(([category, hours]) => (
        <BarRow key={category} label={category} value={hours} maxValue={maxHours} formattedValue={formatHours(hours)} />
      ))}
    </div>
  );
}

function PassFailSection({ byReportType }: { byReportType: FleetAnalytics['pass_fail_by_report_type'] }) {
  const rows = (['repair', 'preventive_maintenance'] as const)
    .map((rt) => ({ reportType: rt, breakdown: byReportType[rt] }))
    .filter((row) => row.breakdown && row.breakdown.total > 0);

  if (rows.length === 0) {
    return <div className="empty-hint">No finalized repair or preventive maintenance reports with a pass/fail result yet.</div>;
  }

  return (
    <>
      <div className="legend-row">
        <span className="legend-item">
          <span className="legend-swatch good" /> Pass
        </span>
        <span className="legend-item">
          <span className="legend-swatch crit" /> Fail
        </span>
        <span className="legend-item">
          <span className="legend-swatch other" /> Not recorded
        </span>
      </div>
      <div className="stack-chart">
        {rows.map(({ reportType, breakdown }) => (
          <div className="stack-row" key={reportType}>
            <div className="bar-row-label">
              <span className="bar-label">{REPORT_TYPE_LABEL[reportType]}</span>
            </div>
            <div className="stack-track">
              {breakdown.pass_count > 0 && (
                <div
                  className="stack-seg good"
                  style={{ flexGrow: breakdown.pass_count }}
                  title={`Pass: ${breakdown.pass_count}`}
                />
              )}
              {breakdown.fail_count > 0 && (
                <div
                  className="stack-seg crit"
                  style={{ flexGrow: breakdown.fail_count }}
                  title={`Fail: ${breakdown.fail_count}`}
                />
              )}
              {breakdown.other_count > 0 && (
                <div
                  className="stack-seg other"
                  style={{ flexGrow: breakdown.other_count }}
                  title={`Not recorded: ${breakdown.other_count}`}
                />
              )}
            </div>
            <span className="bar-value">
              {breakdown.pass_count}/{breakdown.total} pass
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

export function AnalyticsScreen() {
  const [data, setData] = useState<FleetAnalytics | null>(null);
  const { loading, error } = useAsyncEffect(
    async (isCancelled) => {
      const result = await getFleetAnalytics();
      if (!isCancelled()) setData(result);
    },
    [],
    'Could not load fleet analytics.'
  );

  if (loading) {
    return (
      <div className="section">
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading fleet analytics…</div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="section">
        <div className="banner banner-warn">{error ?? 'Could not load fleet analytics.'}</div>
      </div>
    );
  }

  const totalUnitsReplaced = data.parts_replaced.reduce((sum, p) => sum + p.total_qty, 0);
  const totalReports = data.labor_hours_by_instrument.reduce((sum, r) => sum + r.report_count, 0);

  return (
    <div className="section">
      <div className="section-title">Fleet analytics</div>
      <p className="hint-text">
        Computed from every finalized repair and preventive-maintenance report — draft/in-review reports aren't
        counted yet since their data isn't final.
      </p>

      <div className="stat-row">
        <div className="stat-tile">
          <span className="stat-value">{formatHours(data.total_labor_hours)}</span>
          <span className="stat-label">Total labor hours</span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{totalUnitsReplaced}</span>
          <span className="stat-label">Units replaced ({data.parts_replaced.length} distinct parts)</span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{totalReports}</span>
          <span className="stat-label">Repair/PM reports counted</span>
        </div>
      </div>

      <div className="chart-section">
        <div className="chart-title">Most replaced parts</div>
        <PartsChart parts={data.parts_replaced} />
      </div>

      <div className="chart-section">
        <div className="chart-title">Labor hours by instrument</div>
        <LaborHoursByInstrumentChart rows={data.labor_hours_by_instrument} />
      </div>

      <div className="chart-section">
        <div className="chart-title">Labor hours by fault category (repair only)</div>
        <LaborHoursByFaultCategoryChart byCategory={data.labor_hours_by_fault_category} />
      </div>

      <div className="chart-section">
        <div className="chart-title">Pass / fail rate</div>
        <PassFailSection byReportType={data.pass_fail_by_report_type} />
      </div>

      <ModelComparisonSection />
    </div>
  );
}
