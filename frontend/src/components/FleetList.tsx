import { useState } from 'react';
import type { FleetAnalytics } from '../api';

/**
 * The list beside the analytics charts: the whole fleet, then one row per model, instrument or
 * place. Each row carries its hours as a small bar and how its repair and preventive maintenance
 * reports came out as a coloured dot, so the costly or failing ones stand out without opening
 * anything. Choosing a row narrows every chart to it (AnalyticsScreen turns the choice into the
 * model, instrument or place filter the page already has).
 */

export type GroupBy = 'model' | 'instrument' | 'place';
export type FleetSelection = { kind: GroupBy; id: string; name: string } | null;

export const GROUPS: { kind: GroupBy; label: string; all: string }[] = [
  { kind: 'place', label: 'Place', all: 'All places' },
  { kind: 'model', label: 'Model', all: 'All models' },
  { kind: 'instrument', label: 'Instrument', all: 'All instruments' },
];

export type FleetRow = {
  key: string;
  /** The filter value this row stands for; null when it cannot be chosen (a unit with no model record). */
  id: string | null;
  name: string;
  sub: string;
  reports: number;
  hours: number;
  pass: number;
  fail: number;
  other: number;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const hoursText = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)}h`;

/** Pass rate as a whole percent, or null when no repair or preventive maintenance report has a result to count. */
export function passRate(pass: number, fail: number, other: number): number | null {
  const total = pass + fail + other;
  return total === 0 ? null : Math.round((pass / total) * 100);
}

function tone(rate: number | null): 'good' | 'warn' | 'crit' | 'none' {
  if (rate === null) return 'none';
  if (rate >= 90) return 'good';
  if (rate >= 80) return 'warn';
  return 'crit';
}

/** The rows for one grouping, from the fleet data fetched with the page filters only. */
export function fleetRows(data: FleetAnalytics, kind: GroupBy): FleetRow[] {
  if (kind === 'model') {
    return (data.report_counts_by_model ?? []).map((m) => ({
      key: m.model_id ?? m.model,
      id: m.model_id ?? null,
      name: m.model,
      sub: `${plural(m.unit_count, 'instrument')} · ${plural(m.report_count, 'report')}`,
      reports: m.report_count,
      hours: m.total_labor_hours ?? 0,
      pass: m.pass_count ?? 0,
      fail: m.fail_count ?? 0,
      other: m.other_count ?? 0,
    }));
  }
  if (kind === 'instrument') {
    return [...(data.report_counts_by_instrument ?? [])]
      .sort((a, b) => b.report_count - a.report_count || a.name.localeCompare(b.name))
      .map((r) => ({
        key: r.instrument_id,
        id: r.instrument_id,
        name: r.name,
        sub: [r.model !== r.name ? r.model : '', r.serial_number, plural(r.report_count, 'report')].filter(Boolean).join(' · '),
        reports: r.report_count,
        hours: r.total_labor_hours ?? 0,
        pass: r.pass_count ?? 0,
        fail: r.fail_count ?? 0,
        other: r.other_count ?? 0,
      }));
  }
  return (data.place_rollups ?? []).map((p) => ({
    key: p.place_id,
    id: p.place_id,
    name: p.name,
    sub: [p.kind === 'institution' ? 'Institution' : `${p.kind === 'faculty' ? 'Faculty' : 'Room'} in ${p.institution_name}`, plural(p.instrument_count, 'instrument')].join(' · '),
    reports: p.report_count,
    hours: p.total_labor_hours,
    pass: p.pass_count ?? 0,
    fail: p.fail_count ?? 0,
    other: p.other_count ?? 0,
  }));
}

function Figures({ row, maxHours }: { row: FleetRow; maxHours: number }) {
  const rate = passRate(row.pass, row.fail, row.other);
  return (
    <>
      <span className="fleet-row-hours">
        <span className="fleet-row-hours-text">{hoursText(row.hours)}</span>
        <span className="fleet-row-bar" aria-hidden="true">
          <span style={{ width: `${maxHours > 0 ? Math.round((row.hours / maxHours) * 100) : 0}%` }} />
        </span>
      </span>
      <span className="fleet-row-pass" title={rate === null ? 'No repair or preventive maintenance result recorded' : `${row.pass} of ${row.pass + row.fail + row.other} passed`}>
        <span className={`fleet-dot ${tone(rate)}`} aria-hidden="true" />
        <span>{rate === null ? '–' : `${rate}%`}</span>
      </span>
    </>
  );
}

export function FleetList({
  data,
  groupBy,
  setGroupBy,
  selection,
  onSelect,
  loading,
  limit,
}: {
  data: FleetAnalytics;
  groupBy: GroupBy;
  setGroupBy: (g: GroupBy) => void;
  selection: FleetSelection;
  onSelect: (s: FleetSelection) => void;
  loading: boolean;
  /** On a narrow screen only this many rows show until "Show all" is pressed. */
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const allRows = fleetRows(data, groupBy);
  const maxHours = Math.max(0, ...allRows.map((r) => r.hours));
  const rows = limit && !expanded ? allRows.slice(0, limit) : allRows;
  const totals = Object.values(data.pass_fail_by_report_type ?? {}).reduce(
    (t, b) => ({ pass: t.pass + b.pass_count, fail: t.fail + b.fail_count, other: t.other + b.other_count }),
    { pass: 0, fail: 0, other: 0 }
  );
  const whole: FleetRow = {
    key: 'fleet',
    id: null,
    name: 'Whole fleet',
    sub: plural(data.report_counts_by_instrument?.length ?? 0, 'instrument'),
    reports: data.finalized_report_count,
    hours: data.total_labor_hours,
    ...totals,
  };
  const selectedHere = selection && selection.kind === groupBy ? selection.id : null;

  return (
    <aside className="fleet-list" data-testid="fleet-list" aria-label="Fleet list" aria-busy={loading}>
      <div className="fleet-list-head">
        <div className="fleet-list-label" id="fleet-group-label">
          Group by
        </div>
        <div className="sub-switch fleet-group-switch" role="tablist" aria-labelledby="fleet-group-label">
          {GROUPS.map((g) => (
            <button
              key={g.kind}
              type="button"
              role="tab"
              aria-selected={groupBy === g.kind}
              className={groupBy === g.kind ? 'active' : ''}
              onClick={() => setGroupBy(g.kind)}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>
      <ul className="fleet-rows">
        <li>
          <button
            type="button"
            className={`fleet-row${selection === null ? ' selected' : ''}`}
            data-testid="fleet-row-all"
            aria-pressed={selection === null}
            onClick={() => onSelect(null)}
          >
            <span className="fleet-row-name">
              <span className="fleet-row-title">{whole.name}</span>
              <span className="fleet-row-sub">
                {whole.sub} · {plural(whole.reports, 'report')}
              </span>
            </span>
            <Figures row={whole} maxHours={data.total_labor_hours} />
          </button>
        </li>
        {rows.length === 0 && <li className="fleet-empty">Nothing to list for these filters.</li>}
        {rows.map((row) => (
          <li key={row.key}>
            {row.id === null ? (
              <div className="fleet-row fleet-row-static" title="This unit has no model record, so it cannot be chosen on its own.">
                <span className="fleet-row-name">
                  <span className="fleet-row-title">{row.name}</span>
                  <span className="fleet-row-sub">{row.sub}</span>
                </span>
                <Figures row={row} maxHours={maxHours} />
              </div>
            ) : (
              <button
                type="button"
                className={`fleet-row${selectedHere === row.id ? ' selected' : ''}`}
                data-testid="fleet-row"
                aria-pressed={selectedHere === row.id}
                onClick={() => onSelect({ kind: groupBy, id: row.id!, name: row.name })}
              >
                <span className="fleet-row-name">
                  <span className="fleet-row-title">{row.name}</span>
                  <span className="fleet-row-sub">{row.sub}</span>
                </span>
                <Figures row={row} maxHours={maxHours} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {limit !== undefined && allRows.length > limit && (
        <button type="button" className="btn small fleet-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer' : `Show all ${allRows.length}`}
        </button>
      )}
      <div className="fleet-legend">
        <span>Bar: labor hours</span>
        <span>
          <span className="fleet-dot good" aria-hidden="true" /> 90% or more pass
        </span>
        <span>
          <span className="fleet-dot warn" aria-hidden="true" /> 80 to 89%
        </span>
        <span>
          <span className="fleet-dot crit" aria-hidden="true" /> under 80%
        </span>
      </div>
    </aside>
  );
}
