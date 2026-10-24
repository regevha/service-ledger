import { useCallback, useEffect, useState } from 'react';
import { ApiError, getAppConfig, listInstruments, type AppConfig, type Instrument, type ReportTemplate } from './api';
import { AnalyticsScreen } from './components/AnalyticsScreen';
import { InstrumentManagerScreen } from './components/InstrumentManager';
import { IntakeFlow } from './components/IntakeFlow';
import { ReportsListScreen } from './components/ReportsListScreen';
import { TemplateManagerScreen } from './components/TemplateManager';
import type { TemplateRequest } from './templateRequest';
import './App.css';

// Fallback only, for the brief window before GET /config resolves (or if it
// fails) — matches backend/app/config.py's own defaults so behavior is
// unchanged in that window. The real values always come from the backend
// from then on (see the config state below); this used to be two hardcoded
// constants with no connection to the backend's actual settings at all.
const DEFAULT_APP_CONFIG: AppConfig = {
  field_confidence_threshold: 0.7,
  classification_confidence_threshold: 0.85,
};

// The top-level app shell: the masthead, the view tabs, and the fleet list
// every tab below draws on. Each tab's own screen lives in its own file
// under components/ (AnalyticsScreen, TemplateManager, InstrumentManager,
// ReportsListScreen, IntakeFlow) — this file only owns what's genuinely
// shared across all of them: the instrument list (fetched once here and
// threaded down, so a create/edit anywhere refreshes it everywhere) and the
// app-wide confidence-threshold config.
export default function App() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [instrumentsLoading, setInstrumentsLoading] = useState(true);
  const [instrumentsError, setInstrumentsError] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG);

  // Independent of IntakeFlow's own internal phase state (upload → classify
  // → review → done) — `view` just switches which top-level screen is
  // showing. Switching to 'reports' and back leaves an in-progress intake
  // exactly where it was, since IntakeFlow stays mounted underneath.
  const [view, setView] = useState<'new' | 'reports' | 'analytics' | 'templates' | 'instruments'>('new');
  // A report the Reports tab should open as soon as it shows (set when an
  // upload is refused because the file is already on file; cleared once the
  // tab has opened it).
  const [openReportId, setOpenReportId] = useState<string | null>(null);
  // A report waiting for a template of its own: the Templates tab opens a
  // prefilled form for it, and when a template is saved the intake flow reads
  // the report again (templateCreated; its nonce changes on every save).
  const [templateRequest, setTemplateRequest] = useState<TemplateRequest | null>(null);
  const [templateCreated, setTemplateCreated] = useState<{ template: ReportTemplate; nonce: number } | null>(null);

  // A pending request only lives while the Templates tab is showing it.
  function selectView(next: typeof view) {
    if (next !== 'templates') setTemplateRequest(null);
    setView(next);
  }

  // A callback (not just an effect) because the Instruments tab creates and
  // edits rows in place — after a save there, this same list needs to
  // refetch so the Reports filter dropdown and the instrument detail page
  // (both fed by this one top-level `instruments` array) see the change
  // immediately instead of only after a full reload.
  const refreshInstruments = useCallback(() => {
    setInstrumentsLoading(true);
    return listInstruments()
      .then((list) => {
        setInstruments(list);
        setInstrumentsError(null);
      })
      .catch((e: unknown) => setInstrumentsError(e instanceof ApiError ? e.message : 'Could not load instruments.'))
      .finally(() => setInstrumentsLoading(false));
  }, []);

  useEffect(() => {
    void refreshInstruments();
  }, [refreshInstruments]);

  useEffect(() => {
    // Cosmetic-only if this never resolves (badge color / review-flagging),
    // so failure here just means staying on DEFAULT_APP_CONFIG rather than
    // surfacing a banner the way instrumentsError does above.
    getAppConfig()
      .then(setConfig)
      .catch(() => undefined);
  }, []);

  // A file dropped anywhere that is not the upload box would make the browser open it
  // in this tab and leave the app, losing a report that is half reviewed. Cancel that;
  // the upload box handles its own drops.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const block = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  return (
    <div className="wrap">
      <div className="masthead">
        <span className="mark" /> ServiceLedger
        <span className="masthead-sub">core review loop</span>
      </div>

      <div className="view-tabs">
        <button className={`view-tab ${view === 'new' ? 'active' : ''}`} onClick={() => selectView('new')}>
          New report
        </button>
        <button className={`view-tab ${view === 'reports' ? 'active' : ''}`} onClick={() => selectView('reports')}>
          Reports
        </button>
        <button className={`view-tab ${view === 'analytics' ? 'active' : ''}`} onClick={() => selectView('analytics')}>
          Analytics
        </button>
        <button className={`view-tab ${view === 'templates' ? 'active' : ''}`} onClick={() => selectView('templates')}>
          Templates
        </button>
        <button className={`view-tab ${view === 'instruments' ? 'active' : ''}`} onClick={() => selectView('instruments')}>
          Instruments
        </button>
      </div>

      <div className="app-shell">
        {/* The intake flow is rendered (hidden) while the Templates tab shows a
            request made from it, so the waiting report is still there when the
            template is saved; in every other case it is only mounted on its own
            tab, as before. */}
        {(view === 'new' || templateRequest !== null) && (
          <div hidden={view !== 'new'}>
            <IntakeFlow
              instruments={instruments}
              instrumentsError={instrumentsError}
              fieldConfidenceThreshold={config.field_confidence_threshold}
              classificationConfidenceThreshold={config.classification_confidence_threshold}
              liveClaude={config.live_claude !== false}
              onInstrumentAdded={refreshInstruments}
              templateCreated={templateCreated}
              onCreateTemplate={(request) => {
                setTemplateRequest(request);
                setView('templates');
              }}
              onOpenReport={(reportId) => {
                setOpenReportId(reportId);
                selectView('reports');
              }}
            />
          </div>
        )}
        {view === 'analytics' && <AnalyticsScreen />}
        {view === 'templates' && (
          <TemplateManagerScreen
            knownModels={[...new Set(instruments.map((i) => i.model))].sort()}
            request={templateRequest}
            onRequestClose={(saved) => {
              setTemplateRequest(null);
              // Saved or cancelled, the waiting report is on the New report tab:
              // after a save it reads itself again with the new template.
              if (saved) setTemplateCreated({ template: saved, nonce: Date.now() });
              setView('new');
            }}
          />
        )}
        {view === 'instruments' && (
          <InstrumentManagerScreen
            instruments={instruments}
            loading={instrumentsLoading}
            error={instrumentsError}
            onRefresh={refreshInstruments}
          />
        )}
        {view === 'reports' && (
          <ReportsListScreen
            instruments={instruments}
            fieldConfidenceThreshold={config.field_confidence_threshold}
            openReportId={openReportId}
            onOpenReportHandled={() => setOpenReportId(null)}
          />
        )}
      </div>
    </div>
  );
}
