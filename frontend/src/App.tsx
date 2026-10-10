import { useCallback, useEffect, useState } from 'react';
import { ApiError, getAppConfig, listInstruments, type AppConfig, type Instrument } from './api';
import { AnalyticsScreen } from './components/AnalyticsScreen';
import { InstrumentManagerScreen } from './components/InstrumentManager';
import { IntakeFlow } from './components/IntakeFlow';
import { ReportsListScreen } from './components/ReportsListScreen';
import { TemplateManagerScreen } from './components/TemplateManager';
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

  return (
    <div className="wrap">
      <div className="masthead">
        <span className="mark" /> ServiceLedger
        <span className="masthead-sub">core review loop</span>
      </div>

      <div className="view-tabs">
        <button className={`view-tab ${view === 'new' ? 'active' : ''}`} onClick={() => setView('new')}>
          New report
        </button>
        <button className={`view-tab ${view === 'reports' ? 'active' : ''}`} onClick={() => setView('reports')}>
          Reports
        </button>
        <button className={`view-tab ${view === 'analytics' ? 'active' : ''}`} onClick={() => setView('analytics')}>
          Analytics
        </button>
        <button className={`view-tab ${view === 'templates' ? 'active' : ''}`} onClick={() => setView('templates')}>
          Templates
        </button>
        <button className={`view-tab ${view === 'instruments' ? 'active' : ''}`} onClick={() => setView('instruments')}>
          Instruments
        </button>
      </div>

      <div className="app-shell">
        {view === 'analytics' ? (
          <AnalyticsScreen />
        ) : view === 'templates' ? (
          <TemplateManagerScreen />
        ) : view === 'instruments' ? (
          <InstrumentManagerScreen
            instruments={instruments}
            loading={instrumentsLoading}
            error={instrumentsError}
            onRefresh={refreshInstruments}
          />
        ) : view === 'reports' ? (
          <ReportsListScreen
            instruments={instruments}
            fieldConfidenceThreshold={config.field_confidence_threshold}
            openReportId={openReportId}
            onOpenReportHandled={() => setOpenReportId(null)}
          />
        ) : (
          <IntakeFlow
            instruments={instruments}
            instrumentsError={instrumentsError}
            fieldConfidenceThreshold={config.field_confidence_threshold}
            classificationConfidenceThreshold={config.classification_confidence_threshold}
            liveClaude={config.live_claude !== false}
            onOpenReport={(reportId) => {
              setOpenReportId(reportId);
              setView('reports');
            }}
          />
        )}
      </div>
    </div>
  );
}
