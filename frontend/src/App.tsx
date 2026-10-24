import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  getAppConfig,
  getOnboardingStatus,
  listInstruments,
  loadDemoData,
  removeDemoData,
  type AppConfig,
  type Instrument,
  type OnboardingStatus,
  type ReportTemplate,
} from './api';
import { AnalyticsScreen } from './components/AnalyticsScreen';
import { FirstRunBanners } from './components/FirstRun';
import { FirstRunProvider, type FirstRun } from './firstRun';
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

type View = 'new' | 'reports' | 'analytics' | 'templates' | 'instruments';
const VIEWS: View[] = ['new', 'reports', 'analytics', 'templates', 'instruments'];

// Where the app is lives in the address bar (#/reports, #/reports/<report id>,
// #/reports/instrument/<instrument id>), so Refresh keeps the place, Back and Forward
// move between screens, and a report can be bookmarked or sent to a colleague.
interface Route {
  view: View;
  /** Only the Reports tab has one: what is open on it. */
  sub: string;
}

function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const view = VIEWS.find((v) => v === parts[0]) ?? 'new';
  return { view, sub: view === 'reports' ? parts.slice(1).join('/') : '' };
}

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
  // First-run help (GET /onboarding/status): what the empty screens offer, whether demo
  // data is on screen, and whether the background worker is keeping up.
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  // Bumped when the data changes under the screens (demo data loaded or removed): the
  // screens that list it are remounted with this as their key, so they load it again.
  const [dataVersion, setDataVersion] = useState(0);

  // Independent of IntakeFlow's own internal phase state (upload → classify
  // → review → done) — `view` just switches which top-level screen is
  // showing. Switching to 'reports' and back leaves an in-progress intake
  // exactly where it was, since IntakeFlow stays mounted underneath.
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const view = route.view;
  // Changing this discards the intake flow's state (and any work still running in it): "Cancel".
  const [intakeKey, setIntakeKey] = useState(0);
  // A report waiting for a template of its own: the Templates tab opens a
  // prefilled form for it, and when a template is saved the intake flow reads
  // the report again (templateCreated; its nonce changes on every save).
  const [templateRequest, setTemplateRequest] = useState<TemplateRequest | null>(null);
  const [templateCreated, setTemplateCreated] = useState<{ template: ReportTemplate; nonce: number } | null>(null);

  // Go to a screen: the address bar changes (a new history entry) and the app follows it.
  const navigate = useCallback((next: View, sub = '') => {
    // A pending template request only lives while the Templates tab is showing it.
    if (next !== 'templates') setTemplateRequest(null);
    const hash = `#/${next}${sub ? `/${sub}` : ''}`;
    if (window.location.hash !== hash) window.location.hash = hash;
    setRoute((r) => (r.view === next && r.sub === sub ? r : { view: next, sub }));
  }, []);
  const selectView = (next: View) => navigate(next);

  // Back, Forward, or an edited address.
  useEffect(() => {
    const onHash = () => {
      const next = parseHash(window.location.hash);
      if (next.view !== 'templates') setTemplateRequest(null);
      setRoute(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);


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

  const refreshStatus = useCallback(() => {
    // Advisory only: when it fails the notices simply stay as they were.
    return getOnboardingStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  // Polled, because the worker can stop (or start) at any time and a demo can be loaded
  // from another tab. A hidden tab does not ask.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshStatus();
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  // Also when moving between screens: finalizing a sample report changes the counts.
  useEffect(() => {
    void refreshStatus();
  }, [view, refreshStatus]);

  const firstRun: FirstRun = {
    status,
    goTo: (next) => navigate(next),
    loadDemo: async () => {
      await loadDemoData();
      setDataVersion((v) => v + 1);
      await Promise.all([refreshStatus(), refreshInstruments()]);
    },
    removeDemo: async () => {
      await removeDemoData();
      setDataVersion((v) => v + 1);
      await refreshStatus();
    },
  };

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
        {/* Templates and Instruments are set up once and then rarely touched, so they sit apart,
            under their own label, instead of looking like three more things to do before the first report. */}
        <div className="view-tab-setup" role="group" aria-label="Setup">
          <span className="view-tab-setup-label" aria-hidden="true">
            Setup
          </span>
          <button className={`view-tab ${view === 'templates' ? 'active' : ''}`} onClick={() => selectView('templates')}>
            Templates
          </button>
          <button className={`view-tab ${view === 'instruments' ? 'active' : ''}`} onClick={() => selectView('instruments')}>
            Instruments
          </button>
        </div>
      </div>

      <FirstRunProvider value={firstRun}>
        <FirstRunBanners />

        <div className="app-shell">
          {/* The intake flow is rendered (hidden) while the Templates tab shows a
              request made from it, so the waiting report is still there when the
              template is saved; in every other case it is only mounted on its own
              tab, as before. */}
          {(view === 'new' || templateRequest !== null) && (
            <div hidden={view !== 'new'}>
              <IntakeFlow
                key={intakeKey}
                instruments={instruments}
                instrumentsError={instrumentsError}
                fieldConfidenceThreshold={config.field_confidence_threshold}
                classificationConfidenceThreshold={config.classification_confidence_threshold}
                liveClaude={config.live_claude !== false}
                onInstrumentAdded={refreshInstruments}
                templateCreated={templateCreated}
                onCreateTemplate={(request) => {
                  setTemplateRequest(request);
                  navigate('templates');
                }}
                onOpenReport={(reportId) => navigate('reports', reportId)}
                onViewInstrument={(instrumentId) => navigate('reports', `instrument/${instrumentId}`)}
                onCancel={() => setIntakeKey((k) => k + 1)}
              />
            </div>
          )}
          {view === 'analytics' && <AnalyticsScreen key={dataVersion} />}
          {view === 'templates' && (
            <TemplateManagerScreen
              knownModels={[...new Set(instruments.map((i) => i.model))].sort()}
              request={templateRequest}
              onRequestClose={(saved) => {
                setTemplateRequest(null);
                // Saved or cancelled, the waiting report is on the New report tab:
                // after a save it reads itself again with the new template.
                if (saved) setTemplateCreated({ template: saved, nonce: Date.now() });
                navigate('new');
              }}
            />
          )}
          {view === 'instruments' && (
            <InstrumentManagerScreen
              key={dataVersion}
              instruments={instruments}
              loading={instrumentsLoading}
              error={instrumentsError}
              onRefresh={refreshInstruments}
            />
          )}
          {view === 'reports' && (
            <ReportsListScreen
              key={dataVersion}
              instruments={instruments}
              fieldConfidenceThreshold={config.field_confidence_threshold}
              path={route.sub}
              onPath={(sub) => navigate('reports', sub)}
            />
          )}
        </div>
      </FirstRunProvider>
    </div>
  );
}
