import { useEffect, useState } from 'react';
import {
  getFleetAnalytics,
  listInstruments,
  type AnalyticsFilters,
  type FleetAnalytics,
  type Instrument,
  type InstrumentRollup,
  type PartUsage,
  type ReportType,
} from '../api';
import { useAsyncEffect } from '../hooks/useAsyncEffect';
import { REPORT_TYPE_LABEL } from '../labels';
import { DateInput } from './DateInput';
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

/** True when there are several rows and they all have the same value: bars would be identical. */
function allSame(values: number[]): boolean {
  return values.length > 1 && values.every((v) => v === values[0]);
}

function CountList({ rows }: { rows: { key: string; label: string; sublabel?: string; text: string }[] }) {
  return (
    <ul className="count-list">
      {rows.map((r) => (
        <li key={r.key}>
          <span>
            {r.label}
            {r.sublabel && <span className="bar-sublabel">{r.sublabel}</span>}
          </span>
          <span className="bar-value">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

function PartsChart({ parts }: { parts: PartUsage[] }) {
  if (parts.length === 0) {
    return <div className="empty-hint">No parts recorded on any finalized report yet.</div>;
  }
  const top = parts.slice(0, TOP_PARTS_LIMIT);
  const maxQty = Math.max(...top.map((p) => p.total_qty));
  const partText = (p: PartUsage) =>
    `${p.total_qty} unit${p.total_qty === 1 ? '' : 's'} · ${p.times_replaced} report${p.times_replaced === 1 ? '' : 's'}`;
  return (
    <>
      {allSame(top.map((p) => p.total_qty)) ? (
        <CountList
          rows={top.map((p) => ({
            key: `${p.part_name}-${p.part_number ?? ''}`,
            label: p.part_name,
            sublabel: p.part_number ? `#${p.part_number}` : undefined,
            text: partText(p),
          }))}
        />
      ) : (
      <div className="bar-chart">
        {top.map((p) => (
          <BarRow
            key={`${p.part_name}-${p.part_number ?? ''}`}
            label={p.part_name}
            sublabel={p.part_number ? `#${p.part_number}` : undefined}
            value={p.total_qty}
            maxValue={maxQty}
            formattedValue={partText(p)}
          />
        ))}
      </div>
      )}
      {parts.length > TOP_PARTS_LIMIT && (
        <div className="hint-text chart-footnote">
          Showing the top {TOP_PARTS_LIMIT} of {parts.length} distinct parts, by units replaced.
        </div>
      )}
    </>
  );
}

function LaborHoursByInstrumentChart({ rows, withoutHours }: { rows: InstrumentRollup[]; withoutHours: number }) {
  // Most hours first; instruments with none keep their alphabetical order at the bottom.
  const sorted = [...rows].sort((a, b) => b.total_labor_hours - a.total_labor_hours || a.name.localeCompare(b.name));
  const maxHours = Math.max(...sorted.map((r) => r.total_labor_hours), 0);
  const anyHours = maxHours > 0;
  return (
    <>
      <p className="chart-note">
        Hours recorded on finalized repair and preventive maintenance reports, added up per instrument.
      </p>
      {!anyHours && (
        <div className="empty-hint">
          No hours to show yet. A bar appears once a finalized repair or preventive maintenance report has a number in its
          labor field.
        </div>
      )}
      <div className="bar-chart">
        {sorted.map((r) => (
          <BarRow
            key={r.instrument_id}
            label={r.name}
            sublabel={[r.model, r.institution, r.serial_number].filter(Boolean).join(' · ')}
            value={r.total_labor_hours}
            maxValue={maxHours}
            formattedValue={
              r.report_count === 0
                ? 'No hours recorded'
                : `${formatHours(r.total_labor_hours)} · ${r.report_count} report${r.report_count === 1 ? '' : 's'}`
            }
          />
        ))}
      </div>
      {withoutHours > 0 && (
        <p className="chart-note">
          {withoutHours} finalized repair or preventive maintenance report{withoutHours === 1 ? ' was' : 's were'} not counted:
          no number in the labor field, or no instrument on the report.
        </p>
      )}
    </>
  );
}

function LaborHoursByFaultCategoryChart({ byCategory }: { byCategory: Record<string, number> }) {
  const entries = Object.entries(byCategory).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) {
    return <div className="empty-hint">No repair reports with both labor hours and a fault category yet.</div>;
  }
  const maxHours = Math.max(...entries.map(([, hours]) => hours));
  if (allSame(entries.map(([, hours]) => hours))) {
    return <CountList rows={entries.map(([category, hours]) => ({ key: category, label: category, text: formatHours(hours) }))} />;
  }
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

function FilterBar({ filters, instruments, onChange }: {
  filters: AnalyticsFilters;
  instruments: Instrument[];
  onChange: (next: AnalyticsFilters) => void;
}) {
  const active = Object.values(filters).some(Boolean);
  const manufacturers = Array.from(
    new Set(instruments.map((i) => i.manufacturer?.trim()).filter((m): m is string => Boolean(m)))
  ).sort((a, b) => a.localeCompare(b));
  return (
    <div className="filter-row" data-testid="analytics-filters">
      <select
        aria-label="Manufacturer"
        value={filters.manufacturer ?? ''}
        onChange={(e) => {
          const manufacturer = e.target.value || undefined;
          // Drop a chosen instrument that is not from this maker, so the two never contradict.
          const kept = instruments.find((i) => i.id === filters.instrument_id);
          const clash = manufacturer && kept && (kept.manufacturer?.trim() ?? '') !== manufacturer;
          onChange({ ...filters, manufacturer, instrument_id: clash ? undefined : filters.instrument_id });
        }}
      >
        <option value="">All manufacturers</option>
        {manufacturers.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      <select
        aria-label="Instrument"
        value={filters.instrument_id ?? ''}
        onChange={(e) => onChange({ ...filters, instrument_id: e.target.value || undefined })}
      >
        <option value="">All instruments</option>
        {instruments
          .filter((inst) => !filters.manufacturer || (inst.manufacturer?.trim() ?? '') === filters.manufacturer)
          .map((inst) => (
          <option key={inst.id} value={inst.id}>
            {inst.model} ({inst.serial_number})
          </option>
        ))}
      </select>

      <select
        aria-label="Report type"
        value={filters.report_type ?? ''}
        onChange={(e) => onChange({ ...filters, report_type: (e.target.value || undefined) as ReportType | undefined })}
      >
        <option value="">All report types</option>
        {(Object.keys(REPORT_TYPE_LABEL) as ReportType[]).map((rt) => (
          <option key={rt} value={rt}>
            {REPORT_TYPE_LABEL[rt]}
          </option>
        ))}
      </select>

      <DateInput
        ariaLabel="From date"
        value={filters.date_from ?? ''}
        onChange={(v) => onChange({ ...filters, date_from: v || undefined })}
      />
      <span className="filter-sep">to</span>
      <DateInput
        ariaLabel="To date"
        value={filters.date_to ?? ''}
        onChange={(v) => onChange({ ...filters, date_to: v || undefined })}
      />

      {active && (
        <button type="button" className="btn small" onClick={() => onChange({})}>
          Clear filters
        </button>
      )}
    </div>
  );
}

export function AnalyticsScreen() {
  const [data, setData] = useState<FleetAnalytics | null>(null);
  const [filters, setFilters] = useState<AnalyticsFilters>({});
  const [instruments, setInstruments] = useState<Instrument[]>([]);

  useEffect(() => {
    let cancelled = false;
    listInstruments()
      .then((list) => {
        if (!cancelled) setInstruments(list);
      })
      .catch(() => {
        // The instrument filter just stays empty; the analytics themselves still load.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const backwards = Boolean(filters.date_from && filters.date_to && filters.date_from > filters.date_to);
  const filterKey = JSON.stringify(filters);

  const { loading, error } = useAsyncEffect(
    async (isCancelled) => {
      if (backwards) return; // the server refuses it; the page says so instead
      const result = await getFleetAnalytics(filters);
      if (!isCancelled()) setData(result);
    },
    [filterKey],
    'Could not load fleet analytics.'
  );

  const filterBar = <FilterBar filters={filters} instruments={instruments} onChange={setFilters} />;

  if (backwards) {
    return (
      <div className="section">
        <div className="section-title">Fleet analytics</div>
        {filterBar}
        <div className="banner banner-warn">The "from" date is after the "to" date.</div>
      </div>
    );
  }

  // Only the first load replaces the page; after that the controls stay put and the figures refresh.
  if (!data && loading) {
    return (
      <div className="section">
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading fleet analytics…</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="section">
        <div className="banner banner-warn">{error ?? 'Could not load fleet analytics.'}</div>
      </div>
    );
  }

  const totalUnitsReplaced = data.parts_replaced.reduce((sum, p) => sum + p.total_qty, 0);
  const totalReports = data.labor_hours_by_instrument.reduce((sum, r) => sum + r.report_count, 0);
  const filtered = Object.values(filters).some(Boolean);

  return (
    <div className="section">
      <div className="section-title">Fleet analytics</div>
      <p className="hint-text">
        Computed from finalized reports — draft/in-review reports aren't counted yet since their data isn't final.
        The filters below apply to everything on this page. A date range leaves out reports that have no report date.
      </p>

      {filterBar}
      {error && <div className="banner banner-warn">{error}</div>}

      <p className="hint-text" data-testid="analytics-basis" aria-live="polite">
        {loading ? 'Updating…' : `Based on ${data.finalized_report_count} finalized report${data.finalized_report_count === 1 ? '' : 's'}${filtered ? ' matching the filters' : ''}.`}
      </p>

      {!loading && data.finalized_report_count === 0 && filtered && (
        <div className="empty-hint">No finalized reports match these filters.</div>
      )}

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
        <LaborHoursByInstrumentChart
          rows={data.labor_hours_by_instrument}
          withoutHours={data.reports_without_labor_hours ?? 0}
        />
      </div>

      <div className="chart-section">
        <div className="chart-title">Labor hours by fault category (repair only)</div>
        <LaborHoursByFaultCategoryChart byCategory={data.labor_hours_by_fault_category} />
      </div>

      <div className="chart-section">
        <div className="chart-title">Pass / fail rate</div>
        <PassFailSection byReportType={data.pass_fail_by_report_type} />
      </div>

      <ModelComparisonSection filters={filters} />
    </div>
  );
}
