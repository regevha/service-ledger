import { useMemo, useRef } from 'react';
import { useElementWidth } from '../hooks/useElementWidth';
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

  if (dated.length === 0) {
    return (
      <div className="empty-hint">
        No report with a work date yet{undated ? ` (${undated} without a date)` : ''}.
      </div>
    );
  }

  // The axis runs from a few days before the first report to a few days after the last one.
  const first = dayNumber(dated[0].report_date);
  const last = dayNumber(dated[dated.length - 1].report_date);
  const pad = Math.max(3, Math.round((last - first) * 0.04));
  const from = first - pad;
  const to = last + pad;
  const plotW = width - MARGIN.left - MARGIN.right;
  const xAt = (day: number) => MARGIN.left + ((day - from) / (to - from)) * plotW;

  // Markers that would touch (the same day, or days close together at this width) stack upwards
  // instead of covering each other: each goes in the lowest row whose last marker is far enough left.
  const rowOf = new Map<string, number>();
  const lastXInRow: number[] = [];
  for (const r of dated) {
    const x = xAt(dayNumber(r.report_date));
    let row = lastXInRow.findIndex((lastX) => x - lastX >= DOT_R * 2 + 3);
    if (row < 0) row = lastXInRow.length;
    lastXInRow[row] = x;
    rowOf.set(r.id, row);
  }
  const rows = Math.max(1, lastXInRow.length);
  const axisY = MARGIN.top + (rows - 1) * ROW_H + AXIS_GAP;
  const height = axisY + 30;

  const tickCount = Math.max(2, Math.min(6, Math.floor(plotW / TICK_LABEL_W)));
  const ticks = Array.from({ length: tickCount }, (_, i) => Math.round(from + ((to - from) * i) / (tickCount - 1)));

  return (
    <div className="trend-chart-card" ref={cardRef}>
      <div className="trend-chart-head">
        <div className="legend-row">
          {typesPresent.map((k) => (
            <span className="legend-item" key={k}>
              <span className="legend-key" style={{ background: colorOf(k) }} />
              {REPORT_TYPE_LABEL[k as keyof typeof REPORT_TYPE_LABEL]}
            </span>
          ))}
        </div>
        <TrendViewSwitch showTable={showTable} onChange={onShowTable} pictureLabel="Timeline" />
      </div>

      {!showTable && (
        <div className="trend-chart-wrap">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`Work dates: ${dated.length} report${dated.length === 1 ? '' : 's'}, ${formatDate(dated[0].report_date)} to ${formatDate(dated[dated.length - 1].report_date)}`}
          >
            <line x1={MARGIN.left} x2={width - MARGIN.right} y1={axisY} y2={axisY} className="trend-grid" />
            {ticks.map((t) => (
              <g key={t}>
                <line x1={xAt(t)} x2={xAt(t)} y1={axisY} y2={axisY + 5} className="trend-grid" />
                <text x={xAt(t)} y={axisY + 20} textAnchor="middle" className="trend-tick-label">
                  {formatDate(isoOf(t))}
                </text>
              </g>
            ))}
            {dated.map((r) => (
              <circle
                key={r.id}
                className="timeline-dot"
                data-testid="timeline-dot"
                cx={xAt(dayNumber(r.report_date))}
                cy={axisY - 14 - (rowOf.get(r.id) ?? 0) * ROW_H}
                r={DOT_R}
                fill={colorOf(r.report_type)}
              >
                <title>
                  {[
                    formatDate(r.report_date),
                    r.report_type ? REPORT_TYPE_LABEL[r.report_type] : null,
                    r.technician_name,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </title>
              </circle>
            ))}
          </svg>
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
                    <span className="timeline-chip" style={{ background: colorOf(r.report_type) }} />
                    {r.report_type ? REPORT_TYPE_LABEL[r.report_type] : '—'}
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
