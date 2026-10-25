import { BarRow } from './BarRow';

export interface BarItem {
  key: string;
  label: string;
  /** A smaller second line under the label. */
  sub?: string;
  value: number;
  /** Shown on hover. */
  title: string;
}

/**
 * Horizontal bars, one per item, all on one scale so the items compare at a glance. Items arrive in the
 * order to draw (callers sort most first). An item with nothing says "none" instead of showing an empty track.
 */
export function HorizontalBarChart({ items, format, testId, ariaLabel, barClass = '' }: {
  items: BarItem[];
  /** How a value reads at the end of its bar ("12.5h", "7"). */
  format: (value: number) => string;
  testId: string;
  ariaLabel: string;
  /** The class of every row, so a caller's tests can find them. */
  barClass?: string;
}) {
  const maxValue = Math.max(...items.map((i) => i.value), 0);
  return (
    <div className="bar-chart" data-testid={testId} role="group" aria-label={ariaLabel}>
      {items.map((item) => (
        <BarRow
          key={item.key}
          className={barClass}
          label={item.label}
          sublabel={item.sub}
          value={item.value}
          maxValue={maxValue}
          formattedValue={item.value > 0 ? format(item.value) : 'none'}
          tooltip={item.title}
        />
      ))}
    </div>
  );
}
