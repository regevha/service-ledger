import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, getHomeSummary, listReportsPage, type HomeSummary, type Instrument, type ReportFilters, type ReportListItem } from '../api';
import { REPORT_TYPE_LABEL, STATUS_LABEL } from '../labels';
import { dueText, finalizedNote, instrumentLabel, keptAsReadPercent, maintenanceItems, MIN_FIELDS_FOR_PERCENT, waitingAge, waitingReports } from '../home';
import { AskReportsBox } from './AskReportsBox';
import { LoadError } from './LoadError';

// How many waiting reports and upcoming services the lists show before pointing at the full screens.
const SHOWN = 6;

interface Loaded {
  waiting: ReportListItem[];
  summary: HomeSummary;
}

function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The Home screen, where the app opens: a box to ask about the reports in plain words, a place to drop new
 * reports (anywhere on the page), four figures that say how the work stands, and the two short lists a person
 * acts on, the reports waiting for a check and the instruments whose maintenance is overdue or close.
 * Everything here is read from the same data the other screens show; nothing is stored on this screen.
 */
export function HomeScreen({
  instruments,
  instrumentsLoading,
  onOpenReport,
  onOpenInstrument,
  onNewReport,
  onOpenReports,
  onOpenInstruments,
  onAsk,
  onFiles,
}: {
  instruments: Instrument[];
  instrumentsLoading: boolean;
  onOpenReport: (reportId: string) => void;
  onOpenInstrument: (instrumentId: string) => void;
  onNewReport: () => void;
  onOpenReports: () => void;
  onOpenInstruments: () => void;
  /** The filters a typed request turned into; the app opens Reports with them. */
  onAsk: (filters: ReportFilters) => void;
  /** Files dropped on the page or chosen with the button; the app opens the several-files screen with them. */
  onFiles: (files: File[]) => void;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Fixed for the life of the screen, so the lists do not shift if midnight passes while it is open.
  const [today] = useState(() => new Date());
  // True while files are being dragged over the page, so the drop box can show it will take them.
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  // Files can be dropped anywhere on this screen, not only on the box.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const over = (e: DragEvent) => {
      if (hasFiles(e)) setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) onFilesRef.current(files);
    };
    window.addEventListener('dragenter', over);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', over);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const load = useCallback(() => {
    return Promise.all([
      // Only the newest few of each are shown, so only those are loaded; the counts come from the summary.
      listReportsPage({ status: 'extracted' }, SHOWN, 0),
      listReportsPage({ status: 'in_review' }, SHOWN, 0),
      getHomeSummary(),
    ])
      .then(([extracted, inReview, summary]) => {
        setError(null);
        setData({ waiting: waitingReports(extracted.items, inReview.items), summary });
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load the reports.'));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const maintenance = useMemo(() => maintenanceItems(instruments, today), [instruments, today]);
  const overdue = maintenance.filter((m) => m.overdue).length;
  const dueSoon = maintenance.length - overdue;

  const heading = today.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="home" data-testid="home-screen">
      <div className="home-head">
        <h1 className="home-title">Home</h1>
        <span className="home-date">{heading}</span>
      </div>

      {error && <LoadError message={error} onRetry={() => void load()} />}

      <div className="home-ask" data-testid="home-ask">
        <AskReportsBox
          onApply={onAsk}
          showUnderstood={false}
          label="Ask about your reports"
          placeholder="PM reports on the FACSAria III in September"
          submitLabel="Show reports"
        />
      </div>

      <div
        className={`home-add${dragging ? ' dragging' : ''}`}
        data-testid="home-drop"
        onDragOver={(e) => e.preventDefault()}
      >
        <span className="home-add-icon" aria-hidden="true">
          +
        </span>
        <span className="home-add-text">
          <strong>Drop service reports anywhere on this page</strong>
          <small>PDFs or photos, one or many. Each one becomes its own report that you confirm.</small>
        </span>
        <div className="home-add-actions">
          <button type="button" className="btn" data-testid="home-choose-files" onClick={() => fileInput.current?.click()}>
            Choose files
          </button>
          <button type="button" className="btn primary" data-testid="home-new-report" onClick={onNewReport}>
            Add one by hand
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept="application/pdf,image/*"
          aria-label="Choose service reports"
          data-testid="home-file-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length > 0) onFiles(files);
          }}
        />
      </div>

      <div className="home-tiles" aria-label="Summary">
        <div className={`stat-tile home-tile${data && data.summary.waiting.count > 0 ? ' attention' : ''}`} data-testid="home-tile-review">
          <span className="stat-value">{data ? data.summary.waiting.count : '–'}</span>
          <span className="stat-label">Waiting for you</span>
          <span className="home-tile-note">
            {data === null
              ? ' '
              : data.summary.waiting.count === 0
                ? 'Nothing is waiting for review'
                : `Oldest has waited ${waitingAge(data.summary.waiting.oldest_created_at, today) ?? 'a while'}`}
          </span>
        </div>
        <div className={`stat-tile home-tile${overdue > 0 ? ' attention' : ''}`} data-testid="home-tile-overdue">
          <span className="stat-value">{instrumentsLoading ? '–' : overdue}</span>
          <span className="stat-label">Instruments overdue for maintenance</span>
          <span className="home-tile-note">
            {instrumentsLoading
              ? ' '
              : instruments.length === 0
                ? 'Add instruments to track their service'
                : overdue > 0
                  ? maintenance
                      .filter((m) => m.overdue)
                      .slice(0, 2)
                      .map((m) => `${m.label} (${dueText(m.days)})`)
                      .join(', ')
                  : dueSoon > 0
                    ? `${dueSoon} more due soon`
                    : 'None due soon either'}
          </span>
        </div>
        <div className="stat-tile home-tile" data-testid="home-tile-finalized">
          <span className="stat-value">{data ? data.summary.finalized.this_month : '–'}</span>
          <span className="stat-label">Finalized this month</span>
          <span className="home-tile-note">{data ? finalizedNote(data.summary.finalized) : ' '}</span>
        </div>
        <div className="stat-tile home-tile" data-testid="home-tile-accuracy">
          <span className="stat-value">{data ? (keptAsReadPercent(data.summary.read_without_edits) ?? '–') : '–'}</span>
          <span className="stat-label">Fields read without edits</span>
          <span className="home-tile-note">
            {data === null
              ? ' '
              : keptAsReadPercent(data.summary.read_without_edits) !== null
                ? `${data.summary.read_without_edits.fields} fields on ${data.summary.read_without_edits.reports} reports, last ${data.summary.read_without_edits.days} days`
                : `Shown after ${MIN_FIELDS_FOR_PERCENT} fields are finalized (${data.summary.read_without_edits.fields} so far)`}
          </span>
        </div>
      </div>

      <div className="home-cols">
        <section className="home-card" aria-labelledby="home-waiting-title">
          <div className="home-card-head">
            <h2 id="home-waiting-title">Needs your attention</h2>
            <button type="button" className="btn small" onClick={onOpenReports}>
              All reports
            </button>
          </div>
          {data === null && !error && <div className="home-empty">Loading…</div>}
          {data && data.waiting.length === 0 && (
            <div className="home-empty" data-testid="home-waiting-empty">
              Nothing is waiting for review.
            </div>
          )}
          {data && data.waiting.length > 0 && (
            <ul className="home-list" data-testid="home-waiting">
              {data.waiting.slice(0, SHOWN).map((r) => (
                <li key={r.id} className="home-row" data-testid="home-waiting-row">
                  <div className="home-row-main">
                    <span className="home-row-title">{instrumentLabel(r.instrument_model, r.instrument_serial_number)}</span>
                    <span className="home-row-sub">
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
            <div className="home-more">
              {data.waiting.length - SHOWN} more waiting.{' '}
              <button type="button" className="link-button" onClick={onOpenReports}>
                See them in Reports
              </button>
            </div>
          )}
        </section>

        <section className="home-card" aria-labelledby="home-maintenance-title">
          <div className="home-card-head">
            <h2 id="home-maintenance-title">Maintenance due</h2>
            <button type="button" className="btn small" onClick={onOpenInstruments}>
              All instruments
            </button>
          </div>
          {instrumentsLoading && <div className="home-empty">Loading…</div>}
          {!instrumentsLoading && maintenance.length === 0 && (
            <div className="home-empty" data-testid="home-maintenance-empty">
              No instrument is overdue or due soon.
            </div>
          )}
          {maintenance.length > 0 && (
            <ul className="home-list" data-testid="home-maintenance">
              {maintenance.slice(0, SHOWN).map((m) => (
                <li key={m.id}>
                  <button type="button" className="home-row home-row-button" data-testid="home-maintenance-row" onClick={() => onOpenInstrument(m.id)}>
                    <div className="home-row-main">
                      <span className="home-row-title">{m.label}</span>
                      <span className="home-row-sub">{[m.place, `Due ${formatDay(m.dueDate)}`].filter(Boolean).join(' · ')}</span>
                    </div>
                    <span className={`status-pill maintenance-${m.overdue ? 'overdue' : 'due_soon'}`}>{dueText(m.days)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {maintenance.length > SHOWN && (
            <div className="home-more">
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
