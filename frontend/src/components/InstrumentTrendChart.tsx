import { useMemo, useRef, useState } from 'react';
import { getInstrumentTrend, getInstrumentTrendFields, type InstrumentTrend, type TrendField, type TrendPoint } from '../api';
import { useAsyncEffect } from '../hooks/useAsyncEffect';

/**
 * The instrument detail page's trend chart — the real version of
 * docs/instrument-timeline-demo.html's per-detector calibration-drift
 * mockup, generalized to any of a template's numeric fields rather than
 * one hardcoded field for one hardcoded instrument.
 *
 * Built per the dataviz skill: a line chart for change-over-time, one
 * series per field for a flat "number" field or one series per detector/
 * laser key for a number[detector]/number[laser] field, categorical color
 * from the app's --series-1..5 tokens (dataviz's validated slots 1-5, fixed
 * order — see index.css), a hover crosshair + one-tooltip-every-series
 * readout, a legend whenever there are >= 2 series, and a table-view
 * fallback so every value stays reachable without hovering. Hand-rolled SVG
 * rather than a charting library, matching AnalyticsScreen's bars — this
 * app has no charting dependency and one more chart type doesn't earn one.
 */

const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];

interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | undefined)[];
}

function buildSeries(field: TrendField, points: TrendPoint[]): Series[] {
  if (field.type === 'number') {
    return [
      {
        key: field.name,
        label: field.name.replace(/_/g, ' '),
        color: SERIES_COLORS[0],
        values: points.map((p) => (typeof p.value === 'number' ? p.value : undefined)),
      },
    ];
  }
  // number[detector] / number[laser]: the union of keys across every point,
  // in a fixed alphabetical order — fixed so a series never gets recolored
  // as the data changes (dataviz skill: "color follows the entity, never
  // its rank").
  const keys = Array.from(
    new Set(points.flatMap((p) => (typeof p.value === 'object' && p.value ? Object.keys(p.value) : [])))
  ).sort();
  return keys.map((key, i) => ({
    key,
    label: key.replace(/_/g, ' '),
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    values: points.map((p) => (typeof p.value === 'object' && p.value ? p.value[key] : undefined)),
  }));
}

// A "nice" axis ceiling (1/2/5 * 10^n) rather than the raw max, so gridline
// labels round to clean numbers per the dataviz skill's mark spec.
function niceCeil(rawMax: number): number {
  if (rawMax <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const norm = rawMax / magnitude;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return niceNorm * magnitude;
}

function formatValue(value: number, unit: string | null): string {
  // Always one decimal place, even for a whole number like 5 -> "5.0" - a
  // column mixing "5" with "5.1"/"5.2" reads as inconsistent formatting,
  // not as a meaningfully different value.
  const rounded = value.toFixed(1);
  if (!unit) return rounded;
  return unit === '%' ? `${rounded}%` : `${rounded} ${unit}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const MARGIN = { top: 16, right: 16, bottom: 28, left: 40 };
const CHART_W = 640;
const CHART_H = 260;
const PLOT_W = CHART_W - MARGIN.left - MARGIN.right;
const PLOT_H = CHART_H - MARGIN.top - MARGIN.bottom;

function TrendLineChart({ field, points }: { field: TrendField; points: TrendPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const series = useMemo(() => buildSeries(field, points), [field, points]);
  const n = points.length;

  const allValues = series.flatMap((s) => s.values).filter((v): v is number => v !== undefined);
  const rawMax = allValues.length ? Math.max(...allValues) : 1;
  const yMax = niceCeil(rawMax * 1.15);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMax * f);

  function xAt(i: number) {
    return n <= 1 ? MARGIN.left + PLOT_W / 2 : MARGIN.left + (i / (n - 1)) * PLOT_W;
  }
  function yAt(v: number) {
    return MARGIN.top + PLOT_H - (v / yMax) * PLOT_H;
  }

  // Consecutive runs of defined values per series — a gap (a report that
  // didn't record this particular key) breaks the line rather than
  // connecting across missing data.
  function runsFor(s: Series): { x: number; y: number }[][] {
    const runs: { x: number; y: number }[][] = [];
    let current: { x: number; y: number }[] = [];
    s.values.forEach((v, i) => {
      if (v === undefined) {
        if (current.length) runs.push(current);
        current = [];
      } else {
        current.push({ x: xAt(i), y: yAt(v) });
      }
    });
    if (current.length) runs.push(current);
    return runs;
  }

  function handlePointerMove(evt: React.PointerEvent<SVGRectElement>) {
    const svg = svgRef.current;
    if (!svg || n === 0) return;
    const rect = svg.getBoundingClientRect();
    const scale = CHART_W / rect.width;
    const localX = (evt.clientX - rect.left) * scale;
    const i = Math.round(((localX - MARGIN.left) / PLOT_W) * (n - 1));
    setHoverIndex(Math.max(0, Math.min(n - 1, i)));
  }

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const tooltipX = hoverIndex !== null ? xAt(hoverIndex) : 0;
  const tooltipPct = (tooltipX / CHART_W) * 100;

  // Direct end-value label only makes sense for a single series — with
  // several, converging/diverging lines would collide (marks-and-anatomy:
  // "past ~4 converging series, small multiples is usually right"); the
  // legend + tooltip + table carry it instead.
  const soleSeries = series.length === 1 ? series[0] : null;
  const soleLastIndex = soleSeries ? soleSeries.values.findLastIndex((v) => v !== undefined) : -1;

  return (
    <div className="trend-chart-card">
      <div className="trend-chart-head">
        {series.length >= 2 && (
          <div className="legend-row">
            {series.map((s) => (
              <span className="legend-item" key={s.key}>
                <span className="legend-key" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        )}
        <button type="button" className="btn small" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </button>
      </div>

      {!showTable && (
        <div className="trend-chart-wrap">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            role="img"
            aria-label={`${field.name.replace(/_/g, ' ')} across ${n} report${n === 1 ? '' : 's'}`}
          >
            {yTicks.map((t) => (
              <g key={t}>
                <line
                  x1={MARGIN.left}
                  x2={CHART_W - MARGIN.right}
                  y1={yAt(t)}
                  y2={yAt(t)}
                  className="trend-grid"
                />
                <text x={MARGIN.left - 8} y={yAt(t) + 3} textAnchor="end" className="trend-tick-label">
                  {t % 1 === 0 ? t : t.toFixed(1)}
                </text>
              </g>
            ))}

            {points.map((p, i) => (
              <text key={p.report_id} x={xAt(i)} y={CHART_H - 8} textAnchor="middle" className="trend-tick-label">
                {formatDate(p.report_date)}
              </text>
            ))}

            {series.map((s) =>
              runsFor(s).map((run, runIdx) => (
                <g key={`${s.key}-${runIdx}`}>
                  {run.length > 1 && (
                    <polyline
                      points={run.map((pt) => `${pt.x},${pt.y}`).join(' ')}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}
                  {run.map((pt, i) => (
                    <circle key={i} cx={pt.x} cy={pt.y} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                  ))}
                </g>
              ))
            )}

            {soleSeries && soleLastIndex >= 0 && (
              <text
                x={xAt(soleLastIndex) - 8}
                y={yAt(soleSeries.values[soleLastIndex]!) - 12}
                textAnchor="end"
                className="trend-end-label"
              >
                {formatValue(soleSeries.values[soleLastIndex]!, field.unit)}
              </text>
            )}

            {hoverIndex !== null && (
              <>
                <line
                  x1={tooltipX}
                  x2={tooltipX}
                  y1={MARGIN.top}
                  y2={CHART_H - MARGIN.bottom}
                  className="trend-crosshair"
                />
                {series.map((s) => {
                  const v = s.values[hoverIndex];
                  if (v === undefined) return null;
                  return (
                    <circle key={s.key} cx={tooltipX} cy={yAt(v)} r={6} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                  );
                })}
              </>
            )}

            <rect
              x={MARGIN.left}
              y={MARGIN.top}
              width={PLOT_W}
              height={PLOT_H}
              fill="transparent"
              onPointerMove={handlePointerMove}
              onPointerLeave={() => setHoverIndex(null)}
            />
          </svg>

          {hovered && (
            <div className="trend-tooltip" style={{ left: `${tooltipPct}%` }}>
              <div className="trend-tooltip-date">{formatDate(hovered.report_date)}</div>
              {series.map((s) => {
                const v = s.values[hoverIndex!];
                if (v === undefined) return null;
                return (
                  <div className="trend-tooltip-row" key={s.key}>
                    <span className="trend-tooltip-key">
                      <span className="legend-key" style={{ background: s.color }} />
                      {s.label}
                    </span>
                    <span className="trend-tooltip-value">{formatValue(v, field.unit)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showTable && (
        <div className="trend-table-wrap">
          <table className="trend-table">
            <thead>
              <tr>
                <th>Date</th>
                {series.map((s) => (
                  <th key={s.key}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={p.report_id}>
                  <td>{formatDate(p.report_date)}</td>
                  {series.map((s) => (
                    <td key={s.key}>{s.values[i] !== undefined ? formatValue(s.values[i]!, field.unit) : '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function InstrumentTrendSection({ instrumentId }: { instrumentId: string }) {
  const [fields, setFields] = useState<TrendField[] | null>(null);
  const [selectedField, setSelectedField] = useState<string>('');
  const [trend, setTrend] = useState<InstrumentTrend | null>(null);

  // A failure here leaves `fields` at null, which the `fields === null`
  // check below already renders as "still loading" — so, as before this was
  // pulled out to useAsyncEffect, this particular error is intentionally
  // never reached by a banner (the early return happens first) and this
  // call's own `error`/`loading` are deliberately left unused here.
  useAsyncEffect(
    async (isCancelled) => {
      const list = await getInstrumentTrendFields(instrumentId);
      if (isCancelled()) return;
      setFields(list);
      if (list.length) setSelectedField(list[0].name);
    },
    [instrumentId],
    'Could not load chartable fields.'
  );

  const { loading, error } = useAsyncEffect(
    async (isCancelled) => {
      if (!selectedField) return;
      const t = await getInstrumentTrend(instrumentId, selectedField);
      if (!isCancelled()) setTrend(t);
    },
    [instrumentId, selectedField],
    "Could not load this field's history."
  );

  if (fields === null) {
    return null; // still loading the field list — the page's own history table below carries the loading state
  }

  if (fields.length === 0) {
    return (
      <div className="trend-section">
        <div className="section-title">Trend</div>
        <div className="empty-hint">No numeric fields have recorded data yet for this instrument.</div>
      </div>
    );
  }

  const fieldMeta = fields.find((f) => f.name === selectedField) ?? fields[0];

  return (
    <div className="trend-section">
      <div className="section-title-row">
        <div className="section-title">Trend</div>
        <select value={selectedField} onChange={(e) => setSelectedField(e.target.value)} aria-label="Field to chart">
          {fields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name.replace(/_/g, ' ')}
              {f.unit ? ` (${f.unit})` : ''}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="banner banner-warn">{error}</div>}

      {loading || !trend ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading history…</div>
        </div>
      ) : trend.points.length === 0 ? (
        <div className="empty-hint">No numeric data recorded for this field yet.</div>
      ) : trend.points.length === 1 ? (
        <div className="trend-single-point">
          <span className="stat-value">
            {typeof trend.points[0].value === 'number'
              ? formatValue(trend.points[0].value, fieldMeta.unit)
              : Object.entries(trend.points[0].value)
                  .map(([k, v]) => `${k}: ${formatValue(v, fieldMeta.unit)}`)
                  .join(' · ')}
          </span>
          <span className="stat-label">
            Only one report ({formatDate(trend.points[0].report_date)}) has recorded this field so far — a trend
            needs at least two.
          </span>
        </div>
      ) : (
        <TrendLineChart field={fieldMeta} points={trend.points} />
      )}
    </div>
  );
}
