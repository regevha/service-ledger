/** One horizontal bar: a label, a bar scaled against `maxValue`, and the value as text. Rows sit in a `.bar-chart` grid so every bar starts and ends in the same place. */
export function BarRow({ label, sublabel, value, maxValue, formattedValue, className = '', tooltip }: {
  label: string;
  sublabel?: string;
  value: number;
  maxValue: number;
  formattedValue: string;
  /** Extra class on the row, for tests and styling. */
  className?: string;
  /** Shown on hover; defaults to "label: value". */
  tooltip?: string;
}) {
  const pct = maxValue > 0 ? Math.max((value / maxValue) * 100, value > 0 ? 2 : 0) : 0;
  return (
    <div className={`bar-row ${className}`.trim()} title={tooltip}>
      <div className="bar-row-label">
        <span className="bar-label">{label}</span>
        {sublabel && <span className="bar-sublabel">{sublabel}</span>}
      </div>
      <div className="bar-track" title={tooltip ?? `${label}: ${formattedValue}`}>
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="bar-value">{formattedValue}</span>
    </div>
  );
}
