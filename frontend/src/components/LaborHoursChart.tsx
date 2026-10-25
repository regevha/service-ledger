import { useRef } from 'react';
import type { InstrumentRollup } from '../api';
import { useElementWidth } from '../hooks/useElementWidth';
import { niceCeil } from './InstrumentTrendChart';

/**
 * Work hours per instrument, as a column chart: one column per instrument, the same scale for all,
 * so the instruments can be compared at a glance. Hand-rolled SVG like the trend chart. The columns
 * are sorted most hours first. Narrow screens give every column a minimum width and scroll sideways
 * rather than squeeze the names together.
 */

const MARGIN = { top: 22, right: 12, bottom: 58, left: 42 };
const PLOT_H = 220;
const MIN_COLUMN = 64;
const MAX_BAR = 64;
const NAME_CHARS = 11;

function hoursText(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

function clip(text: string): string {
  return text.length > NAME_CHARS ? `${text.slice(0, NAME_CHARS - 1)}…` : text;
}

export function LaborHoursChart({ rows }: { rows: InstrumentRollup[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const available = useElementWidth(wrapRef, 640);

  const sorted = [...rows].sort((a, b) => b.total_labor_hours - a.total_labor_hours || a.name.localeCompare(b.name));
  const n = sorted.length;
  const maxHours = Math.max(...sorted.map((r) => r.total_labor_hours), 0);
  const yMax = niceCeil(maxHours * 1.1);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMax * f);

  const width = Math.max(available, MARGIN.left + MARGIN.right + n * MIN_COLUMN);
  const plotW = width - MARGIN.left - MARGIN.right;
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.min(MAX_BAR, slot * 0.6);
  const height = MARGIN.top + PLOT_H + MARGIN.bottom;
  const yAt = (v: number) => MARGIN.top + PLOT_H - (v / yMax) * PLOT_H;

  return (
    <div className="labor-chart-wrap" ref={wrapRef}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Work hours per instrument: ${sorted.map((r) => `${r.name} ${hoursText(r.total_labor_hours)}`).join(', ')}`}
        data-testid="labor-chart"
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line className="trend-grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={yAt(tick)} y2={yAt(tick)} />
            <text className="trend-tick-label" x={MARGIN.left - 6} y={yAt(tick) + 3} textAnchor="end">
              {hoursText(tick)}
            </text>
          </g>
        ))}
        {sorted.map((r, i) => {
          const cx = MARGIN.left + slot * i + slot / 2;
          const h = (r.total_labor_hours / yMax) * PLOT_H;
          return (
            <g className="labor-bar" data-instrument={r.instrument_id} key={r.instrument_id}>
              <title>
                {`${r.name}${r.institution ? ` · ${r.institution}` : ''} · ${r.model} · ${r.serial_number}: ${
                  r.report_count === 0
                    ? 'no hours recorded'
                    : `${hoursText(r.total_labor_hours)} over ${r.report_count} report${r.report_count === 1 ? '' : 's'}`
                }`}
              </title>
              {r.total_labor_hours > 0 ? (
                <>
                  <rect className="labor-bar-fill" x={cx - barW / 2} y={yAt(r.total_labor_hours)} width={barW} height={Math.max(h, 2)} rx={3} />
                  <text className="labor-bar-value" x={cx} y={yAt(r.total_labor_hours) - 5} textAnchor="middle">
                    {hoursText(r.total_labor_hours)}
                  </text>
                </>
              ) : (
                <text className="labor-bar-none" x={cx} y={yAt(0) - 6} textAnchor="middle">
                  none
                </text>
              )}
              <text className="labor-bar-name" x={cx} y={MARGIN.top + PLOT_H + 16} textAnchor="middle">
                {clip(r.name)}
              </text>
              <text className="labor-bar-sub" x={cx} y={MARGIN.top + PLOT_H + 30} textAnchor="middle">
                {clip(r.institution ?? r.model)}
              </text>
            </g>
          );
        })}
        <line className="trend-grid labor-axis" x1={MARGIN.left} x2={width - MARGIN.right} y1={yAt(0)} y2={yAt(0)} />
      </svg>
    </div>
  );
}
