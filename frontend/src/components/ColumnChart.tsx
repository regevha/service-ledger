import { useRef } from 'react';
import { useElementWidth } from '../hooks/useElementWidth';
import { niceCeil } from './InstrumentTrendChart';

/**
 * A column chart: one column per item, one shared scale, so the items compare at a glance. Used for
 * the Analytics tab's hours per instrument and reports per instrument or model. Hand-rolled SVG like
 * the trend chart. Items arrive in the order to draw (callers sort most first). Narrow screens give
 * every column a minimum width and scroll sideways rather than squeeze the names together.
 */

export interface ColumnItem {
  key: string;
  /** Under the column (cut to fit; the full text is in the tooltip). */
  name: string;
  /** A smaller second line under the name. */
  sub?: string;
  value: number;
  /** The tooltip. */
  title: string;
}

const MARGIN = { top: 22, right: 12, bottom: 58, left: 42 };
const PLOT_H = 220;
const MIN_COLUMN = 64;
const MAX_BAR = 64;
const CHAR_W = 6.6; // average width of a label character at 11.5px, for fitting names under a column

/** The text cut to what fits in `room` pixels, with an ellipsis; the full text stays in the tooltip. */
function clip(text: string, room: number): string {
  const chars = Math.max(4, Math.floor(room / CHAR_W));
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
}

/** Axis ceiling and ticks. Counts use whole-number steps (1, 2, 5, 10 ...); hours use a rounded ceiling. */
function axis(maxValue: number, wholeNumbers: boolean): { yMax: number; ticks: number[] } {
  if (!wholeNumbers) {
    const yMax = niceCeil(maxValue * 1.1);
    return { yMax, ticks: [0, 0.25, 0.5, 0.75, 1].map((f) => yMax * f) };
  }
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const step = steps.find((s) => maxValue / s <= 5) ?? 1000;
  const top = Math.max(step, Math.ceil(maxValue / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { yMax: top, ticks };
}

export function ColumnChart({
  items,
  format,
  wholeNumbers = false,
  ariaLabel,
  testId,
  barClass = 'column-bar',
}: {
  items: ColumnItem[];
  /** How a value reads on the axis and above a column ("12.5h", "7"). */
  format: (value: number) => string;
  wholeNumbers?: boolean;
  ariaLabel: string;
  testId: string;
  /** The class of each column's group, so a caller's tests can find the columns. */
  barClass?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const available = useElementWidth(wrapRef, 640);

  const n = items.length;
  const maxValue = Math.max(...items.map((i) => i.value), 0);
  const { yMax, ticks } = axis(maxValue, wholeNumbers);

  const width = Math.max(available, MARGIN.left + MARGIN.right + n * MIN_COLUMN);
  const plotW = width - MARGIN.left - MARGIN.right;
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.min(MAX_BAR, slot * 0.6);
  const height = MARGIN.top + PLOT_H + MARGIN.bottom;
  const yAt = (v: number) => MARGIN.top + PLOT_H - (v / yMax) * PLOT_H;

  return (
    <div className="labor-chart-wrap" ref={wrapRef}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} data-testid={testId}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="trend-grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={yAt(tick)} y2={yAt(tick)} />
            <text className="trend-tick-label" x={MARGIN.left - 6} y={yAt(tick) + 3} textAnchor="end">
              {format(tick)}
            </text>
          </g>
        ))}
        {items.map((item, i) => {
          const cx = MARGIN.left + slot * i + slot / 2;
          const h = (item.value / yMax) * PLOT_H;
          return (
            <g className={`labor-bar ${barClass}`} key={item.key} data-key={item.key}>
              <title>{item.title}</title>
              {item.value > 0 ? (
                <>
                  <rect className="labor-bar-fill" x={cx - barW / 2} y={yAt(item.value)} width={barW} height={Math.max(h, 2)} rx={3} />
                  <text className="labor-bar-value" x={cx} y={yAt(item.value) - 5} textAnchor="middle">
                    {format(item.value)}
                  </text>
                </>
              ) : (
                <text className="labor-bar-none" x={cx} y={yAt(0) - 6} textAnchor="middle">
                  none
                </text>
              )}
              <text className="labor-bar-name" x={cx} y={MARGIN.top + PLOT_H + 16} textAnchor="middle">
                {clip(item.name, slot - 6)}
              </text>
              {item.sub && (
                <text className="labor-bar-sub" x={cx} y={MARGIN.top + PLOT_H + 30} textAnchor="middle">
                  {clip(item.sub, slot - 6)}
                </text>
              )}
            </g>
          );
        })}
        <line className="trend-grid labor-axis" x1={MARGIN.left} x2={width - MARGIN.right} y1={yAt(0)} y2={yAt(0)} />
      </svg>
    </div>
  );
}
