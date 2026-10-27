import { useState } from 'react';
import type { PlaceRollup } from '../api';
import { HorizontalBarChart } from './HorizontalBarChart';

/** Reports and work hours per institution, faculty or room: one level at a time, most first. */

const LEVELS = [
  { kind: 'institution', label: 'Institutions' },
  { kind: 'faculty', label: 'Faculties' },
  { kind: 'room', label: 'Rooms' },
] as const;

const hoursText = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
const countText = (n: number) => String(n);
const units = (n: number) => `${n} instrument${n === 1 ? '' : 's'}`;

export function PlaceCharts({ rows, reportsLabel }: { rows: PlaceRollup[]; reportsLabel: string }) {
  const [kind, setKind] = useState<(typeof LEVELS)[number]['kind']>('institution');
  const [measure, setMeasure] = useState<'reports' | 'hours'>('reports');
  if (rows.length === 0) {
    return (
      <div className="empty-hint">
        No places to show yet. Give instruments an institution and room, or add them under Instruments › Places.
      </div>
    );
  }
  const level = rows.filter((r) => r.kind === kind);
  const value = (r: PlaceRollup) => (measure === 'reports' ? r.report_count : r.total_labor_hours);
  const sorted = [...level].sort((a, b) => value(b) - value(a) || a.name.localeCompare(b.name));
  return (
    <>
      <div className="sub-switch place-chart-switch" role="tablist" aria-label="Place level">
        {LEVELS.map((l) => (
          <button
            key={l.kind}
            type="button"
            role="tab"
            aria-selected={kind === l.kind}
            className={kind === l.kind ? 'active' : ''}
            onClick={() => setKind(l.kind)}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className="sub-switch place-chart-switch" role="tablist" aria-label="Measure">
        <button type="button" role="tab" aria-selected={measure === 'reports'} className={measure === 'reports' ? 'active' : ''} onClick={() => setMeasure('reports')}>
          {reportsLabel}
        </button>
        <button type="button" role="tab" aria-selected={measure === 'hours'} className={measure === 'hours' ? 'active' : ''} onClick={() => setMeasure('hours')}>
          Work hours
        </button>
      </div>
      {sorted.length === 0 ? (
        <div className="empty-hint">No {kind === 'faculty' ? 'faculties' : `${kind}s`} with instruments yet.</div>
      ) : (
        <HorizontalBarChart
          testId="place-chart"
          barClass="count-bar"
          ariaLabel={`${measure === 'reports' ? reportsLabel : 'Work hours'} per ${kind}`}
          format={measure === 'reports' ? countText : hoursText}
          items={sorted.map((r) => ({
            key: r.place_id,
            label: r.name,
            sub: [r.kind === 'institution' ? '' : r.institution_name, units(r.instrument_count)].filter(Boolean).join(' · '),
            value: value(r),
            title: `${r.name}${r.kind === 'institution' ? '' : ` · ${r.institution_name}`}: ${units(r.instrument_count)}, ${r.report_count} report${r.report_count === 1 ? '' : 's'}, ${hoursText(r.total_labor_hours)}`,
          }))}
        />
      )}
    </>
  );
}
