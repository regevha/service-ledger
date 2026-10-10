import { useMemo, useState } from 'react';
import {
  getModelComparison,
  getModelTrend,
  type ModelComparison,
  type ModelTrend,
  type PassFailBreakdown,
  type TrendField,
  type UnitComparison,
} from '../api';
import { useAsyncEffect } from '../hooks/useAsyncEffect';
import { SERIES_COLORS, formatDate, formatValue, niceCeil } from './InstrumentTrendChart';

/**
 * "Compare units of the same model" on the Analytics tab: every serial of one
 * model side by side (GET /analytics/models), and one trend chart with a line
 * per unit for a chosen numeric field (GET /analytics/models/trend). Finalized
 * reports only, like the rest of the Analytics tab.
 *
 * The chart's x axis is real time (report dates), unlike a single instrument's
 * trend chart which spaces its own reports evenly: units are serviced on
 * different days, so evenly spaced points would line up visits that did not
 * happen together. A report with no date cannot be placed on that axis, so it
 * is left off the chart (and counted in a note); the table view lists every
 * dated value.
 */

function formatHours(hours: number): string {
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`;
}

function passRate(b: PassFailBreakdown): string {
  return b.total === 0 ? '—' : `${b.pass_count}/${b.total}`;
}

function UnitTable({ units }: { units: UnitComparison[] }) {
  return (
    <div className="trend-table-wrap">
      <table className="trend-table compare-table">
        <thead>
          <tr>
            <th>Serial</th>
            <th>Status</th>
            <th>Finalized reports</th>
            <th>Last report</th>
            <th>Labor hours</th>
            <th>Parts replaced</th>
            <th title="Repair reports whose retest passed">Repairs passed</th>
            <th title="Preventive maintenance reports whose verification passed">PM passed</th>
          </tr>
        </thead>
        <tbody>
          {units.map((u, i) => (
            <tr key={u.instrument_id}>
              <td>
                <span className="legend-key" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length], display: 'inline-block' }} />{' '}
                {u.serial_number}
                <span className="bar-sublabel"> {u.name}</span>
              </td>
              <td>{u.status}</td>
              <td>{u.finalized_report_count}</td>
              <td>{u.last_report_date ? formatDate(u.last_report_date) : '—'}</td>
              <td>
                {formatHours(u.total_labor_hours)}
                <span className="bar-sublabel"> in {u.labor_report_count}</span>
              </td>
              <td>{u.parts_replaced_qty}</td>
              <td>{passRate(u.repair_results)}</td>
              <td>{passRate(u.preventive_maintenance_results)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface UnitLine {
  key: string;
  label: string;
  color: string;
  // Dated points only, ascending.
  points: { reportId: string; t: number; date: string; value: number }[];
  undated: number;
}

// One scalar per report: a flat "number" field as is; for a detector/laser
// field, the chosen key's value (reports without that key are skipped).
function buildLines(trend: ModelTrend, valueKey: string | null): UnitLine[] {
  return trend.series.map((s, i) => {
    const dated: UnitLine['points'] = [];
    let undated = 0;
    for (const p of s.points) {
      const value = typeof p.value === 'number' ? p.value : valueKey ? p.value[valueKey] : undefined;
      if (value === undefined) continue;
      if (!p.report_date) {
        undated += 1;
        continue;
      }
      dated.push({ reportId: p.report_id, t: new Date(`${p.report_date}T00:00:00`).getTime(), date: p.report_date, value });
    }
    dated.sort((a, b) => a.t - b.t);
    return {
      key: s.instrument_id,
      label: s.serial_number,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      points: dated,
      undated,
    };
  });
}

function mapKeys(trend: ModelTrend): string[] {
  const keys = new Set<string>();
  for (const s of trend.series)
    for (const p of s.points) if (typeof p.value === 'object' && p.value) Object.keys(p.value).forEach((k) => keys.add(k));
  return Array.from(keys).sort();
}

const MARGIN = { top: 16, right: 16, bottom: 28, left: 40 };
const CHART_W = 640;
const CHART_H = 260;
const PLOT_W = CHART_W - MARGIN.left - MARGIN.right;
const PLOT_H = CHART_H - MARGIN.top - MARGIN.bottom;

function ComparisonChart({ lines, field }: { lines: UnitLine[]; field: TrendField }) {
  const [showTable, setShowTable] = useState(false);
  const all = lines.flatMap((l) => l.points);
  const undated = lines.reduce((sum, l) => sum + l.undated, 0);

  if (all.length === 0) {
    return (
      <div className="empty-hint">
        No dated values for this field on any unit yet{undated ? ` (${undated} without a report date)` : ''}.
      </div>
    );
  }

  const tMin = Math.min(...all.map((p) => p.t));
  const tMax = Math.max(...all.map((p) => p.t));
  const yMax = niceCeil(Math.max(...all.map((p) => p.value)) * 1.15);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMax * f);
  const xAt = (t: number) => (tMax === tMin ? MARGIN.left + PLOT_W / 2 : MARGIN.left + ((t - tMin) / (tMax - tMin)) * PLOT_W);
  const yAt = (v: number) => MARGIN.top + PLOT_H - (v / yMax) * PLOT_H;
  const xTicks = Array.from(new Set(all.map((p) => p.date))).sort();
  const tableRows = lines
    .flatMap((l) => l.points.map((p) => ({ ...p, unit: l.label, color: l.color })))
    .sort((a, b) => a.t - b.t || a.unit.localeCompare(b.unit));

  return (
    <div className="trend-chart-card">
      <div className="trend-chart-head">
        <div className="legend-row">
          {lines.map((l) => (
            <span className="legend-item" key={l.key}>
              <span className="legend-key" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
        <button type="button" className="btn small" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </button>
      </div>

      {!showTable ? (
        <div className="trend-chart-wrap">
          <svg
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            role="img"
            aria-label={`${field.name.replace(/_/g, ' ')} per unit over time`}
          >
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={MARGIN.left} x2={CHART_W - MARGIN.right} y1={yAt(t)} y2={yAt(t)} className="trend-grid" />
                <text x={MARGIN.left - 8} y={yAt(t) + 3} textAnchor="end" className="trend-tick-label">
                  {t % 1 === 0 ? t : t.toFixed(1)}
                </text>
              </g>
            ))}
            {xTicks.length <= 8 &&
              xTicks.map((d) => (
                <text
                  key={d}
                  x={xAt(new Date(`${d}T00:00:00`).getTime())}
                  y={CHART_H - 8}
                  textAnchor="middle"
                  className="trend-tick-label"
                >
                  {formatDate(d)}
                </text>
              ))}
            {xTicks.length > 8 && (
              <>
                <text x={MARGIN.left} y={CHART_H - 8} textAnchor="start" className="trend-tick-label">
                  {formatDate(xTicks[0])}
                </text>
                <text x={CHART_W - MARGIN.right} y={CHART_H - 8} textAnchor="end" className="trend-tick-label">
                  {formatDate(xTicks[xTicks.length - 1])}
                </text>
              </>
            )}
            {lines.map((l) => (
              <g key={l.key}>
                {l.points.length > 1 && (
                  <polyline
                    points={l.points.map((p) => `${xAt(p.t)},${yAt(p.value)}`).join(' ')}
                    fill="none"
                    stroke={l.color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
                {l.points.map((p) => (
                  <circle key={p.reportId} cx={xAt(p.t)} cy={yAt(p.value)} r={4} fill={l.color} stroke="var(--surface)" strokeWidth={2}>
                    <title>{`${l.label} · ${formatDate(p.date)} · ${formatValue(p.value, field.unit)}`}</title>
                  </circle>
                ))}
              </g>
            ))}
          </svg>
        </div>
      ) : (
        <div className="trend-table-wrap">
          <table className="trend-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Unit</th>
                <th>{field.name.replace(/_/g, ' ')}</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r) => (
                <tr key={`${r.unit}-${r.reportId}`}>
                  <td>{formatDate(r.date)}</td>
                  <td>
                    <span className="legend-key" style={{ background: r.color, display: 'inline-block' }} /> {r.unit}
                  </td>
                  <td>{formatValue(r.value, field.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {undated > 0 && (
        <p className="hint-text">
          {undated} value{undated === 1 ? '' : 's'} without a report date {undated === 1 ? 'is' : 'are'} not shown.
        </p>
      )}
    </div>
  );
}

function ModelTrendSection({ group }: { group: ModelComparison }) {
  const [fieldName, setFieldName] = useState('');
  const [valueKey, setValueKey] = useState('');
  const field = group.trend_fields.find((f) => f.name === fieldName) ?? group.trend_fields[0];
  const [trend, setTrend] = useState<ModelTrend | null>(null);

  const { loading, error } = useAsyncEffect(
    async (isCancelled) => {
      if (!field) return;
      const t = await getModelTrend(group.model, field.name);
      if (!isCancelled()) setTrend(t);
    },
    [group.model, field?.name],
    "Could not load this field's history.",
  );

  const keys = useMemo(() => (trend && field && field.type !== 'number' ? mapKeys(trend) : []), [trend, field]);
  const activeKey = keys.includes(valueKey) ? valueKey : (keys[0] ?? null);
  const lines = useMemo(() => (trend && field && trend.field === field.name ? buildLines(trend, activeKey) : []), [trend, field, activeKey]);

  if (group.trend_fields.length === 0) {
    return <div className="empty-hint">No numeric fields have recorded data yet for this model.</div>;
  }

  return (
    <>
      <div className="section-title-row">
        <div className="chart-title">Trend per unit</div>
        <select value={field?.name ?? ''} onChange={(e) => setFieldName(e.target.value)} aria-label="Field to compare">
          {group.trend_fields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name.replace(/_/g, ' ')}
              {f.unit ? ` (${f.unit})` : ''}
            </option>
          ))}
        </select>
        {keys.length > 0 && (
          <select value={activeKey ?? ''} onChange={(e) => setValueKey(e.target.value)} aria-label="Detector or laser to compare">
            {keys.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <div className="banner banner-warn">{error}</div>}
      {loading || !trend || !field || trend.field !== field.name ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading history…</div>
        </div>
      ) : (
        <ComparisonChart lines={lines} field={field} />
      )}
    </>
  );
}

export function ModelComparisonSection() {
  const [groups, setGroups] = useState<ModelComparison[] | null>(null);
  const [selectedModel, setSelectedModel] = useState('');

  const { loading, error } = useAsyncEffect(
    async (isCancelled) => {
      const result = await getModelComparison();
      if (isCancelled()) return;
      setGroups(result);
      // Start on a model that actually has units to compare.
      const first = result.find((g) => g.units.length >= 2) ?? result[0];
      if (first) setSelectedModel(first.model);
    },
    [],
    'Could not load the model comparison.',
  );

  if (loading) return null; // the fleet section above carries the page's loading state
  if (error) return <div className="banner banner-warn">{error}</div>;
  if (!groups || groups.length === 0) return null;

  const group = groups.find((g) => g.model === selectedModel) ?? groups[0];

  return (
    <div className="chart-section" id="model-comparison">
      <div className="section-title-row">
        <div className="chart-title">Compare units of the same model</div>
        <select value={group.model} onChange={(e) => setSelectedModel(e.target.value)} aria-label="Model to compare">
          {groups.map((g) => (
            <option key={g.model} value={g.model}>
              {g.model} ({g.units.length} unit{g.units.length === 1 ? '' : 's'})
            </option>
          ))}
        </select>
      </div>
      {group.units.length < 2 && (
        <p className="hint-text">
          Only one {group.model} is on file, so there is nothing to compare it with yet. Add another unit on the
          Instruments tab.
        </p>
      )}
      <UnitTable units={group.units} />
      <ModelTrendSection key={group.model} group={group} />
    </div>
  );
}
