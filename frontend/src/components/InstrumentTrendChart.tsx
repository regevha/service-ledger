import { fieldLabel } from '../fieldLabels';
import { useElementWidth } from '../hooks/useElementWidth';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getInstrumentTrend, getInstrumentTrendFields, type InstrumentTrend, type TrendField, type TrendPoint } from '../api';
import { useAsyncEffect } from '../hooks/useAsyncEffect';
import { useMediaQuery } from '../hooks/useMediaQuery';
import type { ReportListItem } from '../api';
import { WorkTimeline } from './WorkTimeline';

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

/** Table first, the picture second ("Chart", or "Timeline" for the work dates). */
export function TrendViewSwitch({
  showTable,
  onChange,
  pictureLabel,
}: {
  showTable: boolean;
  onChange: (table: boolean) => void;
  pictureLabel: string;
}) {
  return (
    <div className="view-switch" role="group" aria-label="Show the trend as">
      <button type="button" className={`btn small${showTable ? ' active' : ''}`} aria-pressed={showTable} onClick={() => onChange(true)}>
        Table
      </button>
      <button type="button" className={`btn small${showTable ? '' : ' active'}`} aria-pressed={!showTable} onClick={() => onChange(false)}>
        {pictureLabel}
      </button>
    </div>
  );
}

export const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];

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
        label: fieldLabel(field.name, field.unit),
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
    label: fieldLabel(key),
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    values: points.map((p) => (typeof p.value === 'object' && p.value ? p.value[key] : undefined)),
  }));
}

// A "nice" axis ceiling (1/2/5 * 10^n) rather than the raw max, so gridline
// labels round to clean numbers per the dataviz skill's mark spec.
export function niceCeil(rawMax: number): number {
  if (rawMax <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const norm = rawMax / magnitude;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return niceNorm * magnitude;
}

export function formatValue(value: number, unit: string | null): string {
  // Always one decimal place, even for a whole number like 5 -> "5.0" - a
  // column mixing "5" with "5.1"/"5.2" reads as inconsistent formatting,
  // not as a meaningfully different value.
  const rounded = value.toFixed(1);
  if (!unit) return rounded;
  return unit === '%' ? `${rounded}%` : `${rounded} ${unit}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Where the end-value label goes: on the side of the last point away from the line that arrives at it,
 * so the label never sits on the line (above when the line rises into it, below when it falls into it).
 */
function endLabelY(values: (number | undefined)[], lastIndex: number, yAt: (v: number) => number): number {
  const lastY = yAt(values[lastIndex]!);
  const prevIndex = values.slice(0, lastIndex).findLastIndex((v) => v !== undefined);
  if (prevIndex < 0) return lastY - 12;
  const prevY = yAt(values[prevIndex]!);
  return prevY < lastY ? lastY + 20 : lastY - 12; // smaller y is higher on the screen
}

const MARGIN = { top: 16, right: 16, bottom: 28, left: 40 };
// The chart is drawn at the width it is shown at (so its text stays the size of the rest of the page
// instead of growing with the window); this is only the width used before it has been measured.
const CHART_W = 640;
const MIN_CHART_W = 320;
const CHART_H = 260;
// A date label is about this wide at the axis font size; labels closer together than this are thinned out.
const DATE_LABEL_W = 84;
const PLOT_H = CHART_H - MARGIN.top - MARGIN.bottom;

function TrendLineChart({
  field,
  points,
  showTable,
  onShowTable,
}: {
  field: TrendField;
  points: TrendPoint[];
  showTable: boolean;
  onShowTable: (table: boolean) => void;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const measured = useElementWidth(cardRef, CHART_W);
  const chartW = Math.max(MIN_CHART_W, measured);
  const plotW = chartW - MARGIN.left - MARGIN.right;

  const series = useMemo(() => buildSeries(field, points), [field, points]);
  const n = points.length;

  const allValues = series.flatMap((s) => s.values).filter((v): v is number => v !== undefined);
  const rawMax = allValues.length ? Math.max(...allValues) : 1;
  const yMax = niceCeil(rawMax * 1.15);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMax * f);

  // Show every k-th date so neighbouring labels never overlap; the tooltip and table carry the rest.
  const labelEvery = n <= 1 ? 1 : Math.max(1, Math.ceil(DATE_LABEL_W / (plotW / (n - 1))));

  function xAt(i: number) {
    return n <= 1 ? MARGIN.left + plotW / 2 : MARGIN.left + (i / (n - 1)) * plotW;
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
    const scale = chartW / rect.width;
    const localX = (evt.clientX - rect.left) * scale;
    const i = Math.round(((localX - MARGIN.left) / plotW) * (n - 1));
    setHoverIndex(Math.max(0, Math.min(n - 1, i)));
  }

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const tooltipX = hoverIndex !== null ? xAt(hoverIndex) : 0;
  const tooltipPct = (tooltipX / chartW) * 100;

  // Direct end-value label only makes sense for a single series — with
  // several, converging/diverging lines would collide (marks-and-anatomy:
  // "past ~4 converging series, small multiples is usually right"); the
  // legend + tooltip + table carry it instead.
  const soleSeries = series.length === 1 ? series[0] : null;
  const soleLastIndex = soleSeries ? soleSeries.values.findLastIndex((v) => v !== undefined) : -1;

  return (
    <div className="trend-chart-card" ref={cardRef}>
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
        <TrendViewSwitch showTable={showTable} onChange={onShowTable} pictureLabel="Chart" />
      </div>

      {!showTable && (
        <div className="trend-chart-wrap">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${chartW} ${CHART_H}`}
            role="img"
            aria-label={`${fieldLabel(field.name, field.unit)} across ${n} report${n === 1 ? '' : 's'}`}
          >
            {yTicks.map((t) => (
              <g key={t}>
                <line
                  x1={MARGIN.left}
                  x2={chartW - MARGIN.right}
                  y1={yAt(t)}
                  y2={yAt(t)}
                  className="trend-grid"
                />
                <text x={MARGIN.left - 8} y={yAt(t) + 3} textAnchor="end" className="trend-tick-label">
                  {t % 1 === 0 ? t : t.toFixed(1)}
                </text>
              </g>
            ))}

            {points.map((p, i) =>
              i % labelEvery === 0 ? (
                <text key={p.report_id} x={xAt(i)} y={CHART_H - 8} textAnchor="middle" className="trend-tick-label">
                  {formatDate(p.report_date)}
                </text>
              ) : null
            )}

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
                y={endLabelY(soleSeries.values, soleLastIndex, yAt)}
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
              width={plotW}
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
        <div className="trend-table-wrap" tabIndex={0} role="region" aria-label="Trend values, as a table">
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

/** The picker's extra choice: a timeline of the dates the instrument was worked on (WorkTimeline.tsx). */
export const WORK_DATES = '__work_dates__';

export function InstrumentTrendSection({
  instrumentId,
  reports,
  focus = false,
}: {
  instrumentId: string;
  reports: ReportListItem[];
  /** Open the (phone-folded) section and bring it into view, for a "Trend" link. */
  focus?: boolean;
}) {
  const [fields, setFields] = useState<TrendField[] | null>(null);
  const [selectedField, setSelectedField] = useState<string>('');
  const [trend, setTrend] = useState<InstrumentTrend | null>(null);
  // Table or picture: the table is the default, and the choice stays when another field or the work dates are picked.
  const [showTable, setShowTable] = useState(true);
  // On a phone the whole section is folded, closed at first, so it costs one line of the page.
  const phone = useMediaQuery('(max-width: 620px)');
  const [open, setOpen] = useState(focus);
  const sectionRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const ready = fields !== null;
  useEffect(() => {
    if (!focus || !ready || scrolled.current) return;
    scrolled.current = true;
    sectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, [focus, ready]);

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
      // No numeric field yet: the work-dates timeline is still something to show.
      setSelectedField(list.length ? list[0].name : WORK_DATES);
    },
    [instrumentId],
    'Could not load chartable fields.'
  );

  const { loading, error } = useAsyncEffect(
    async (isCancelled) => {
      if (!selectedField || selectedField === WORK_DATES) return;
      const t = await getInstrumentTrend(instrumentId, selectedField);
      if (!isCancelled()) setTrend(t);
    },
    [instrumentId, selectedField],
    "Could not load this field's history."
  );

  if (fields === null) {
    return null; // still loading the field list — the page's own history table below carries the loading state
  }

  const timeline = selectedField === WORK_DATES;
  const fieldMeta = fields.find((f) => f.name === selectedField) ?? fields[0];

  const folded = phone && !open;

  return (
    <div ref={sectionRef} className={`trend-section${phone ? ' trend-section-fold' : ''}`} data-testid="trend-section">
      {phone && (
        <button type="button" className="trend-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="section-title">Trend</span>
          <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      )}
      {!folded && (
        <>
      <div className="section-title-row">
        {!phone && <div className="section-title">Trend</div>}
        <select value={selectedField} onChange={(e) => setSelectedField(e.target.value)} aria-label="Field to chart">
          {fields.map((f) => (
            <option key={f.name} value={f.name}>
              {fieldLabel(f.name, f.unit)}
              {f.unit ? ` (${f.unit})` : ''}
            </option>
          ))}
          <option value={WORK_DATES}>Work dates (timeline)</option>
        </select>
      </div>

      {error && !timeline && <div className="banner banner-warn">{error}</div>}

      {timeline ? (
        <WorkTimeline reports={reports} showTable={showTable} onShowTable={setShowTable} />
      ) : loading || !trend ? (
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
        <TrendLineChart field={fieldMeta} points={trend.points} showTable={showTable} onShowTable={setShowTable} />
      )}
        </>
      )}
    </div>
  );
}
