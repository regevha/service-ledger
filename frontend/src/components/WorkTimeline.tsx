import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useElementWidth } from '../hooks/useElementWidth';
import { useMediaQuery } from '../hooks/useMediaQuery';
import type { ReportListItem } from '../api';
import { REPORT_TYPE_LABEL, STATUS_LABEL } from '../labels';
import { SERIES_COLORS, TrendViewSwitch, formatDate } from './InstrumentTrendChart';

/**
 * The "Work dates" choice of the instrument page's Trend section: every report that has a date, as a
 * marker on one time axis, colored by report type. It needs no numeric field, so an instrument whose
 * reports hold only text still gets a picture of when it was worked on. Like the numeric trend it opens
 * as a table (date, type, lab manager, status) with the timeline one click away.
 */

const MARGIN = { left: 24, right: 24, top: 18 };
const AXIS_GAP = 30; // from the lowest marker row to the axis
const ROW_H = 16; // reports on the same day stack upwards
const DOT_R = 6;
const PHONE_ROW_H = 12;
const PHONE_DOT_R = 4.5;
const MIN_W = 320;
const TICK_LABEL_W = 96;
const DAY_MS = 86_400_000;

type Dated = ReportListItem & { report_date: string };

const hasDate = (r: ReportListItem): r is Dated => !!r.report_date;

function dayNumber(iso: string): number {
  return Math.round(new Date(`${iso}T00:00:00Z`).getTime() / DAY_MS);
}

function isoOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

const MIN_SPAN_DAYS = 14; // the closest zoom: two weeks across the plot
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Month steps tried in turn; below a month the steps are in days (weeks start on a Monday).
const MONTH_STEPS = [1, 2, 3, 6, 12, 24, 60, 120];
const DAY_STEPS = [1, 2, 7, 14];

interface Tick {
  day: number;
  label: string;
}

/** Round-date ticks for the window [from, to]: the smallest regular step that still fits `maxTicks` labels. */
function axisTicks(from: number, to: number, maxTicks: number): Tick[] {
  const span = to - from;
  for (const step of DAY_STEPS) {
    if (span / step <= maxTicks) {
      // Aligned to Monday for weeks (day 4 of the epoch week), to multiples of the step otherwise.
      const offset = step === 7 || step === 14 ? 4 : 0;
      const first = Math.ceil((from - offset) / step) * step + offset;
      const out: Tick[] = [];
      for (let d = first; d <= to; d += step) out.push({ day: d, label: formatDate(isoOf(d)) });
      return out;
    }
  }
  // Month starts on multiples of `step` counted from January (a year step is January 1st each year).
  const monthTicks = (step: number): Tick[] => {
    const start = new Date(from * DAY_MS);
    let monthIndex = start.getUTCFullYear() * 12 + start.getUTCMonth();
    if (Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1) / DAY_MS < from) monthIndex += 1;
    monthIndex = Math.ceil(monthIndex / step) * step;
    const out: Tick[] = [];
    for (; ; monthIndex += step) {
      const year = Math.floor(monthIndex / 12);
      const month = monthIndex % 12;
      const day = Date.UTC(year, month, 1) / DAY_MS;
      if (day > to) break;
      out.push({ day, label: step >= 12 ? String(year) : `${MONTH_NAMES[month]} ${year}` });
    }
    return out;
  };
  // The first step that fits, but never fewer than two ticks: a step that would leave one falls back to the finer one.
  let previous: Tick[] = [];
  for (const step of MONTH_STEPS) {
    const ticks = monthTicks(step);
    if (ticks.length <= maxTicks) return ticks.length >= 2 || previous.length === 0 ? ticks : previous;
    previous = ticks;
  }
  return previous;
}

export function WorkTimeline({
  reports,
  showTable,
  onShowTable,
}: {
  reports: ReportListItem[];
  showTable: boolean;
  onShowTable: (table: boolean) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const measured = useElementWidth(cardRef, 640);
  const width = Math.max(MIN_W, measured);
  // Smaller markers and rows on a phone, so the timeline stays a thin strip.
  const phone = useMediaQuery('(max-width: 620px)');
  const dotR = phone ? PHONE_DOT_R : DOT_R;
  const rowH = phone ? PHONE_ROW_H : ROW_H;

  const dated = useMemo(
    () => reports.filter(hasDate).sort((a, b) => a.report_date.localeCompare(b.report_date)),
    [reports],
  );
  const undated = reports.length - dated.length;

  // Colors follow the report type, in a fixed order, so a type never changes color as the data does.
  const typeKeys = Object.keys(REPORT_TYPE_LABEL);
  const colorOf = (type: string | null) => {
    const i = type ? typeKeys.indexOf(type) : -1;
    return i < 0 ? 'var(--muted, #888)' : SERIES_COLORS[i % SERIES_COLORS.length];
  };
  const typesPresent = typeKeys.filter((k) => dated.some((r) => r.report_type === k));

  // The whole range: from a few days before the first report to a few days after the last one.
  const hasData = dated.length > 0;
  const first = hasData ? dayNumber(dated[0].report_date) : 0;
  const last = hasData ? dayNumber(dated[dated.length - 1].report_date) : 0;
  const pad = Math.max(3, Math.round((last - first) * 0.04));
  const fullFrom = first - pad;
  const fullTo = last + pad;
  const fullSpan = fullTo - fullFrom;

  // The window shown. null is the whole range; plus/minus and dragging narrow, widen and move it.
  const [view, setView] = useState<{ from: number; to: number } | null>(null);
  const from = view ? Math.max(fullFrom, view.from) : fullFrom;
  const to = view ? Math.min(fullTo, view.to) : fullTo;
  const span = to - from;
  const zoomed = span < fullSpan - 0.5;
  const canZoomIn = span > MIN_SPAN_DAYS + 0.5;

  const zoomTo = (factor: number) => {
    const centre = (from + to) / 2;
    const nextSpan = Math.min(fullSpan, Math.max(MIN_SPAN_DAYS, span * factor));
    if (nextSpan >= fullSpan - 0.5) return setView(null);
    const nextFrom = Math.min(Math.max(fullFrom, centre - nextSpan / 2), fullTo - nextSpan);
    setView({ from: nextFrom, to: nextFrom + nextSpan });
  };

  // The marker whose card is open (date, type and an Open link).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const drag = useRef<{ x: number; from: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);

  useEffect(() => {
    if (!selectedId) return;
    const close = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setSelectedId(null);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [selectedId]);

  if (!hasData) {
    return (
      <div className="empty-hint">
        No report with a work date yet{undated ? ` (${undated} without a date)` : ''}.
      </div>
    );
  }

  const plotW = width - MARGIN.left - MARGIN.right;
  const xAt = (day: number) => MARGIN.left + ((day - from) / span) * plotW;

  // Only the markers inside the window are drawn.
  const visible = dated.filter((r) => {
    const d = dayNumber(r.report_date);
    return d >= from - 0.5 && d <= to + 0.5;
  });
  const selected = visible.find((r) => r.id === selectedId) ?? null;

  // Markers that would touch (the same day, or days close together at this width) stack upwards
  // instead of covering each other: each goes in the lowest row whose last marker is far enough left.
  const rowOf = new Map<string, number>();
  const lastXInRow: number[] = [];
  for (const r of visible) {
    const x = xAt(dayNumber(r.report_date));
    let row = lastXInRow.findIndex((lastX) => x - lastX >= dotR * 2 + 3);
    if (row < 0) row = lastXInRow.length;
    lastXInRow[row] = x;
    rowOf.set(r.id, row);
  }
  const rows = Math.max(1, lastXInRow.length);
  const axisY = MARGIN.top + (rows - 1) * rowH + AXIS_GAP;
  const height = axisY + 30;

  // Regular ticks on round dates (years, months, weeks or days, by how far in the window is).
  const ticks = axisTicks(from, to, Math.max(2, Math.floor(plotW / TICK_LABEL_W)));

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (!zoomed) return;
    drag.current = { x: e.clientX, from, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 4) d.moved = true;
    if (!d.moved) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const daysPerPx = span / ((plotW / width) * (rect.width || width));
    const nextFrom = Math.min(Math.max(fullFrom, d.from - dx * daysPerPx), fullTo - span);
    setView({ from: nextFrom, to: nextFrom + span });
  };
  const onPointerUp = () => {
    justDragged.current = !!drag.current?.moved;
    drag.current = null;
    if (justDragged.current) setTimeout(() => (justDragged.current = false), 0);
  };
  const toggle = (id: string) => {
    if (justDragged.current) return;
    setSelectedId((cur) => (cur === id ? null : id));
  };
  const onDotKey = (e: KeyboardEvent<SVGCircleElement>, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(id);
    }
  };

  const labelOf = (r: Dated) =>
    [formatDate(r.report_date), r.report_type ? REPORT_TYPE_LABEL[r.report_type] : null, r.technician_name].filter(Boolean).join(' · ');

  return (
    <div className="trend-chart-card" ref={cardRef}>
      <div className="trend-chart-head">
        {/* The table carries each type's color beside its name, so the legend is only for the timeline. */}
        <div className="legend-row">
          {!showTable && typesPresent.map((k) => (
            <span className="legend-item" key={k}>
              <span className="legend-key" style={{ background: colorOf(k) }} />
              {REPORT_TYPE_LABEL[k as keyof typeof REPORT_TYPE_LABEL]}
            </span>
          ))}
        </div>
        <TrendViewSwitch showTable={showTable} onChange={onShowTable} pictureLabel="Timeline" />
      </div>
      {!showTable && (
        <div className="timeline-zoom" role="group" aria-label="Zoom the timeline">
          <button type="button" className="btn small" aria-label="Zoom in" disabled={!canZoomIn} onClick={() => zoomTo(0.5)}>
            +
          </button>
          <button type="button" className="btn small" aria-label="Zoom out" disabled={!zoomed} onClick={() => zoomTo(2)}>
            −
          </button>
          <button type="button" className="btn small" disabled={!zoomed} onClick={() => setView(null)}>
            Reset
          </button>
          {zoomed && <span className="muted">Drag the timeline to move</span>}
        </div>
      )}

      {!showTable && (
        <div className="trend-chart-wrap timeline-wrap">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="group"
            aria-label={`Work dates: ${dated.length} report${dated.length === 1 ? '' : 's'}, ${formatDate(dated[0].report_date)} to ${formatDate(dated[dated.length - 1].report_date)}`}
            className={`timeline-svg${zoomed ? ' timeline-pannable' : ''}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onClick={(e) => e.target === e.currentTarget && setSelectedId(null)}
          >
            <line x1={MARGIN.left} x2={width - MARGIN.right} y1={axisY} y2={axisY} className="trend-grid" />
            {ticks.map((t) => (
              <g key={t.day}>
                <line x1={xAt(t.day)} x2={xAt(t.day)} y1={axisY} y2={axisY + 5} className="trend-grid" />
                <text x={xAt(t.day)} y={axisY + 20} textAnchor="middle" className="trend-tick-label" data-testid="timeline-tick">
                  {t.label}
                </text>
              </g>
            ))}
            {visible.map((r) => {
              const cx = xAt(dayNumber(r.report_date));
              const cy = axisY - 14 - (rowOf.get(r.id) ?? 0) * rowH;
              return (
                <g key={r.id} onPointerDown={(e) => e.stopPropagation()}>
                  {/* A larger invisible target, so a dot is easy to hit with a finger. */}
                  <circle cx={cx} cy={cy} r={Math.max(dotR + 6, 12)} fill="transparent" className="timeline-hit" onClick={() => toggle(r.id)} />
                  <circle
                    className={`timeline-dot${r.id === selectedId ? ' timeline-dot-selected' : ''}`}
                    data-testid="timeline-dot"
                    cx={cx}
                    cy={cy}
                    r={dotR}
                    fill={colorOf(r.report_type)}
                    tabIndex={0}
                    role="button"
                    aria-label={labelOf(r)}
                    aria-expanded={r.id === selectedId}
                    onClick={() => toggle(r.id)}
                    onKeyDown={(e) => onDotKey(e, r.id)}
                  >
                    <title>{labelOf(r)}</title>
                  </circle>
                </g>
              );
            })}
          </svg>
          {selected && (
            <div
              className="timeline-card"
              data-testid="timeline-card"
              role="dialog"
              aria-label="Report"
              style={{ left: `${Math.min(85, Math.max(15, (xAt(dayNumber(selected.report_date)) / width) * 100))}%` }}
            >
              <div className="timeline-card-date">{formatDate(selected.report_date)}</div>
              <div className="timeline-card-type">
                <span className="timeline-chip" style={{ background: colorOf(selected.report_type) }} />
                {selected.report_type ? REPORT_TYPE_LABEL[selected.report_type] : 'Report'}
              </div>
              {selected.technician_name && <div className="stat-label">{selected.technician_name}</div>}
              <div className="timeline-card-actions">
                <a className="btn small primary" data-testid="timeline-open" href={`#/reports/${selected.id}`}>
                  Open
                </a>
                <button type="button" className="btn small" onClick={() => setSelectedId(null)}>
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {showTable && (
        <div className="trend-table-wrap" tabIndex={0} role="region" aria-label="Work dates, as a table">
          <table className="trend-table work-dates-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Lab manager</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {dated.map((r) => (
                <tr key={r.id}>
                  <td>{formatDate(r.report_date)}</td>
                  <td>
                    <span className="type-cell">
                      <span className="timeline-chip" style={{ background: colorOf(r.report_type) }} />
                      {r.report_type ? REPORT_TYPE_LABEL[r.report_type] : '—'}
                    </span>
                  </td>
                  <td>{r.technician_name ?? '—'}</td>
                  <td>{STATUS_LABEL[r.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {undated > 0 && (
        <div className="stat-label">
          {undated} report{undated === 1 ? ' has' : 's have'} no work date and {undated === 1 ? 'is' : 'are'} not shown.
        </div>
      )}
    </div>
  );
}
