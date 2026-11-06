import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, listReports, type Instrument, type ReportListItem } from '../api';
import { REPORT_TYPE_LABEL, STATUS_LABEL } from '../labels';
import { dueText, instrumentLabel, maintenanceItems, monthStart, waitingReports } from '../today';
import { LoadError } from './LoadError';

// How many waiting reports and upcoming services the lists show before pointing at the full screens.
const SHOWN = 6;

interface Loaded {
  waiting: ReportListItem[];
  finalizedThisMonth: number;
}

function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The Today tab: what needs a person's attention, in the order they would do it. The reports that are read
 * and wait for a check, the instruments whose maintenance is overdue or close, and a way to start a new
 * report. Everything here is read from the same data the other tabs show; nothing is stored on this screen.
 */
export function TodayScreen({
  instruments,
  instrumentsLoading,
  onOpenReport,
  onOpenInstrument,
  onNewReport,
  onOpenReports,
  onOpenInstruments,
}: {
  instruments: Instrument[];
  instrumentsLoading: boolean;
  onOpenReport: (reportId: string) => void;
  onOpenInstrument: (instrumentId: string) => void;
  onNewReport: () => void;
  onOpenReports: () => void;
  onOpenInstruments: () => void;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Fixed for the life of the screen, so the lists do not shift if midnight passes while it is open.
  const [today] = useState(() => new Date());

  const load = useCallback(() => {
    return Promise.all([
      listReports({ status: 'extracted' }),
      listReports({ status: 'in_review' }),
      listReports({ status: 'finalized', date_from: monthStart(today) }),
    ])
      .then(([extracted, inReview, finalized]) => {
        setError(null);
        setData({ waiting: waitingReports(extracted, inReview), finalizedThisMonth: finalized.length });
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load the reports.'));
  }, [today]);

  useEffect(() => {
    void load();
  }, [load]);

  const maintenance = useMemo(() => maintenanceItems(instruments, today), [instruments, today]);
  const overdue = maintenance.filter((m) => m.overdue).length;
  const dueSoon = maintenance.length - overdue;

  const heading = today.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="today" data-testid="today-screen">
      <div className="today-head">
        <h1 className="today-title">Today</h1>
        <span className="today-date">{heading}</span>
      </div>

      {error && <LoadError message={error} onRetry={() => void load()} />}

      <div className="today-tiles" aria-label="Summary">
        <div className={`stat-tile today-tile${data && data.waiting.length > 0 ? ' attention' : ''}`} data-testid="today-tile-review">
          <span className="stat-value">{data ? data.waiting.length : '–'}</span>
          <span className="stat-label">Reports to review</span>
        </div>
        <div className={`stat-tile today-tile${overdue > 0 ? ' attention' : ''}`} data-testid="today-tile-overdue">
          <span className="stat-value">{instrumentsLoading ? '–' : overdue}</span>
          <span className="stat-label">Instruments overdue for maintenance</span>
        </div>
        <div className="stat-tile today-tile" data-testid="today-tile-soon">
          <span className="stat-value">{instrumentsLoading ? '–' : dueSoon}</span>
          <span className="stat-label">Maintenance due soon</span>
        </div>
        <div className="stat-tile today-tile" data-testid="today-tile-finalized">
          <span className="stat-value">{data ? data.finalizedThisMonth : '–'}</span>
          <span className="stat-label">Finalized this month</span>
        </div>
      </div>

      <button type="button" className="today-add" data-testid="today-new-report" onClick={onNewReport}>
        <span className="today-add-icon" aria-hidden="true">
          +
        </span>
        <span>
          <strong>Add a service report</strong>
          <small>Upload a PDF or take photos of a form. It is read for you to check.</small>
        </span>
      </button>

      <div className="today-cols">
        <section className="today-card" aria-labelledby="today-waiting-title">
          <div className="today-card-head">
            <h2 id="today-waiting-title">Needs your attention</h2>
            <button type="button" className="btn small" onClick={onOpenReports}>
              All reports
            </button>
          </div>
          {data === null && !error && <div className="today-empty">Loading…</div>}
          {data && data.waiting.length === 0 && (
            <div className="today-empty" data-testid="today-waiting-empty">
              Nothing is waiting for review.
            </div>
          )}
          {data && data.waiting.length > 0 && (
            <ul className="today-list" data-testid="today-waiting">
              {data.waiting.slice(0, SHOWN).map((r) => (
                <li key={r.id} className="today-row" data-testid="today-waiting-row">
                  <div className="today-row-main">
                    <span className="today-row-title">{instrumentLabel(r.instrument_model, r.instrument_serial_number)}</span>
                    <span className="today-row-sub">
                      {[r.report_type ? REPORT_TYPE_LABEL[r.report_type] : null, r.report_date ? formatDay(r.report_date) : null].filter(Boolean).join(' · ') || 'Date not read'}
                    </span>
                  </div>
                  <span className={`status-pill status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                  <button type="button" className="btn small" onClick={() => onOpenReport(r.id)}>
                    Review
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data && data.waiting.length > SHOWN && (
            <div className="today-more">
              {data.waiting.length - SHOWN} more waiting.{' '}
              <button type="button" className="link-button" onClick={onOpenReports}>
                See them in Reports
              </button>
            </div>
          )}
        </section>

        <section className="today-card" aria-labelledby="today-maintenance-title">
          <div className="today-card-head">
            <h2 id="today-maintenance-title">Maintenance due</h2>
            <button type="button" className="btn small" onClick={onOpenInstruments}>
              All instruments
            </button>
          </div>
          {instrumentsLoading && <div className="today-empty">Loading…</div>}
          {!instrumentsLoading && maintenance.length === 0 && (
            <div className="today-empty" data-testid="today-maintenance-empty">
              No instrument is overdue or due soon.
            </div>
          )}
          {maintenance.length > 0 && (
            <ul className="today-list" data-testid="today-maintenance">
              {maintenance.slice(0, SHOWN).map((m) => (
                <li key={m.id}>
                  <button type="button" className="today-row today-row-button" data-testid="today-maintenance-row" onClick={() => onOpenInstrument(m.id)}>
                    <div className="today-row-main">
                      <span className="today-row-title">{m.label}</span>
                      <span className="today-row-sub">{[m.place, `Due ${formatDay(m.dueDate)}`].filter(Boolean).join(' · ')}</span>
                    </div>
                    <span className={`status-pill maintenance-${m.overdue ? 'overdue' : 'due_soon'}`}>{dueText(m.days)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {maintenance.length > SHOWN && (
            <div className="today-more">
              {maintenance.length - SHOWN} more.{' '}
              <button type="button" className="link-button" onClick={onOpenInstruments}>
                See them in Instruments
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
