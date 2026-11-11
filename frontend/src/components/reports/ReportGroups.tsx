import type { ReactNode } from 'react';
import type { ReportListItem } from '../../api';
import type { ReportGroup } from './grouping';

/** The reports grouped by instrument or model, each group with its header and its rows. */
export function ReportGroups({
  groups,
  renderRow,
  onOpenInstrument,
  onOpenTrend,
}: {
  groups: ReportGroup[];
  renderRow: (r: ReportListItem) => ReactNode;
  onOpenInstrument: (instrumentId: string) => void;
  /** Opens the instrument's page at its Trend section. */
  onOpenTrend: (instrumentId: string) => void;
}) {
  return (
    <div className="report-table report-groups" data-testid="report-groups">
      {groups.map((g) => (
        <section className="report-group" key={g.key} data-testid="report-group">
          <header className="report-group-head">
            <div className="report-group-title">
              <strong>{g.title}</strong>
              {g.serial && <span className="report-group-serial">{g.serial}</span>}
              {g.instrument?.location && <span className="report-group-place">{g.instrument.location}</span>}
              {g.units !== undefined && g.units > 0 && (
                <span className="report-group-serial" data-testid="group-units">
                  {g.units} instrument{g.units === 1 ? '' : 's'}
                </span>
              )}
              {g.maker && <span className="report-group-place">{g.maker}</span>}
            </div>
            <div className="report-group-meta">
              <span className="report-group-count">{g.items.length} report{g.items.length === 1 ? '' : 's'}</span>
              {g.needsReview > 0 && <span className="badge badge-warn">{g.needsReview} need{g.needsReview === 1 ? 's' : ''} review</span>}
              {g.instrument && (
                <>
                  <button type="button" className="btn small" data-testid="group-trend-link" onClick={() => onOpenTrend(g.instrument!.id)}>
                    Trend →
                  </button>
                  <button type="button" className="btn small" onClick={() => onOpenInstrument(g.instrument!.id)}>
                    Instrument page →
                  </button>
                </>
              )}
            </div>
            {g.unitInstruments && g.unitInstruments.length > 0 && (
              <div className="report-group-units" data-testid="group-unit-trends">
                <span className="muted">Trend:</span>
                {g.unitInstruments.map((u) => (
                  <button
                    type="button"
                    className="btn small"
                    key={u.id}
                    data-testid="unit-trend-link"
                    aria-label={`Trend of ${u.name}, serial number ${u.serial_number}`}
                    onClick={() => onOpenTrend(u.id)}
                  >
                    {u.serial_number} →
                  </button>
                ))}
              </div>
            )}
          </header>
          <div className="report-group-rows">{g.items.map(renderRow)}</div>
        </section>
      ))}
    </div>
  );
}
