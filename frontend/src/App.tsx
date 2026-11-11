import { ThemeToggle } from './components/ThemeToggle';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, getAppConfig, listInstruments, type AppConfig, type Instrument, type ReportTemplate } from './api';
import { AdminScreen } from './components/AdminScreen';
import { AnalyticsScreen } from './components/AnalyticsScreen';
import { InstrumentManagerScreen } from './components/InstrumentManager';
import { IntakeFlow } from './components/IntakeFlow';
import { ReportsListScreen } from './components/ReportsListScreen';
import { HomeScreen } from './components/HomeScreen';
import { BatchIntake } from './components/BatchIntake';
import { TemplateManagerScreen } from './components/TemplateManager';
import { UnsavedChangesDialog } from './components/UnsavedChangesDialog';
import { ActiveSearchLine } from './components/ActiveSearch';
import { AskSheet, AskSheetButton } from './components/AskSheet';
import { PHONE_QUERY, useMediaQuery } from './hooks/useMediaQuery';
import { InstrumentAskContext } from './instrumentAskContext';
import type { InstrumentAsk } from './instrumentAsk';
import { KeptSearchGate, KeptSearchProvider } from './components/KeptSearchProvider';
import { NavigationGuardContext, type LeaveGuard } from './navigationGuard';
import type { ReportFilters } from './api';
import type { TemplateRequest } from './templateRequest';
import './App.css';
import { ToastHost } from './components/ToastHost';

// Fallback only, for the brief window before GET /config resolves (or if it
// fails) — matches backend/app/config.py's own defaults so behavior is
// unchanged in that window. The real values always come from the backend
// from then on (see the config state below); this used to be two hardcoded
// constants with no connection to the backend's actual settings at all.
const DEFAULT_APP_CONFIG: AppConfig = {
  field_confidence_threshold: 0.7,
  classification_confidence_threshold: 0.85,
};

type View = 'home' | 'new' | 'batch' | 'reports' | 'analytics' | 'templates' | 'instruments' | 'admin' | 'more';
const VIEWS: View[] = ['home', 'new', 'batch', 'reports', 'analytics', 'templates', 'instruments', 'admin', 'more'];

// Where the app is lives in the address bar (#/reports, #/reports/<report id>,
// #/reports/instrument/<instrument id>), so Refresh keeps the place, Back and Forward
// move between screens, and a report can be bookmarked or sent to a colleague.
interface Route {
  view: View;
  /** Reports and Admin have one: what is open on it. */
  sub: string;
}

function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const view = VIEWS.find((v) => v === parts[0]) ?? 'home';
  return { view, sub: view === 'reports' || view === 'admin' ? parts.slice(1).join('/') : '' };
}

// The top-level app shell: the masthead, the view tabs, and the fleet list
// every tab below draws on. Each tab's own screen lives in its own file
// under components/ (AnalyticsScreen, TemplateManager, InstrumentManager,
// ReportsListScreen, IntakeFlow) — this file only owns what's genuinely
// shared across all of them: the instrument list (fetched once here and
// threaded down, so a create/edit anywhere refreshes it everywhere) and the
// app-wide confidence-threshold config.

// Small outline icons for the phone's bottom bar (hidden on wide screens, where the tabs are text only).
function TabIcon({ name }: { name: 'home' | 'new' | 'reports' | 'analytics' | 'templates' | 'instruments' | 'more' }) {
  const common = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, className: 'tab-icon' };
  switch (name) {
    case 'home':
      return (<svg {...common}><path d="M4 11l8-7 8 7v9H4z" /><path d="M10 20v-6h4v6" /></svg>);
    case 'new':
      return (<svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></svg>);
    case 'reports':
      return (<svg {...common}><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></svg>);
    case 'analytics':
      return (<svg {...common}><path d="M4 20V10M10 20V4M16 20v-8M22 20H2" /></svg>);
    case 'templates':
      return (<svg {...common}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 10h16M10 10v10" /></svg>);
    case 'more':
      return (<svg {...common}><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></svg>);
    case 'instruments':
      return (<svg {...common}><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" /><path d="M8 15h8" /></svg>);
  }
}

export default function App() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [instrumentsLoading, setInstrumentsLoading] = useState(true);
  const [instrumentsError, setInstrumentsError] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG);

  // Independent of IntakeFlow's own internal phase state (upload → classify
  // → review → done) — `view` just switches which top-level screen is
  // showing. Switching to 'reports' and back leaves an in-progress intake
  // exactly where it was, since IntakeFlow stays mounted underneath.
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const view = route.view;
  // Changing this discards the intake flow's state (and any work still running in it): "Cancel".
  const [intakeKey, setIntakeKey] = useState(0);
  // Once the several-files screen has been opened it stays mounted (hidden), so its list survives checking a report.
  const [batchOpened, setBatchOpened] = useState(false);
  // Files dropped on Home, waiting for the several-files screen to take them (a new nonce is a new drop).
  const [incomingFiles, setIncomingFiles] = useState<{ files: File[]; nonce: number } | null>(null);
  // Filters a plain-words request on Home turned into, waiting for the Reports screen to start with them.
  const [homeFilters, setHomeFilters] = useState<ReportFilters | null>(null);
  if (view === 'batch' && !batchOpened) setBatchOpened(true);
  // A report waiting for a template of its own: the Templates tab opens a
  // prefilled form for it, and when a template is saved the intake flow reads
  // the report again (templateCreated; its nonce changes on every save).
  const [templateRequest, setTemplateRequest] = useState<TemplateRequest | null>(null);
  const [templateCreated, setTemplateCreated] = useState<{ template: ReportTemplate; nonce: number } | null>(null);

  // The screen on show reports its unsaved edits here (see navigationGuard.ts). Leaving it, by a tab, by the
  // browser's Back button or by one of its own buttons, asks first: Stay, Discard changes, or Save and leave.
  const guardRef = useRef<LeaveGuard | null>(null);
  const [pendingLeave, setPendingLeave] = useState<{ run: () => void; message: string; revert?: () => void } | null>(null);
  const [leaveSaving, setLeaveSaving] = useState(false);
  // The address the app is actually showing. The address bar can run ahead of it while the question is open.
  const shownHash = useRef(window.location.hash);

  const requestLeave = useCallback((run: () => void, opts: { message?: string; target?: View; revert?: () => void } = {}) => {
    const guard = guardRef.current;
    // The intake flow stays mounted on its own tab, so going there loses nothing.
    const losesEdits = guard?.dirty === true && !(guard.scope === 'new' && opts.target === 'new');
    if (!losesEdits) {
      run();
      return;
    }
    setPendingLeave({ run, message: opts.message ?? 'You have changes on this screen that are not saved.', revert: opts.revert });
  }, []);

  // Go to a screen: the address bar changes (a new history entry) and the app follows it.
  // `force` skips the question, for moves that lose nothing (the intake flow keeps its state while the
  // Templates tab builds a template for it).
  const navigate = useCallback(
    (next: View, sub = '', opts: { force?: boolean } = {}) => {
      const hash = `#/${next}${sub ? `/${sub}` : ''}`;
      const go = () => {
        // A pending template request only lives while the Templates tab is showing it.
        if (next !== 'templates') setTemplateRequest(null);
        shownHash.current = hash;
        if (window.location.hash !== hash) window.location.hash = hash;
        setRoute((r) => (r.view === next && r.sub === sub ? r : { view: next, sub }));
      };
      if (opts.force || window.location.hash === hash) go();
      else requestLeave(go, { target: next });
    },
    [requestLeave]
  );
  const selectView = (next: View) => navigate(next);

  // A question about instruments ("more than 2 repairs this year") is answered on the Instruments tab, not by a report search.
  const [instrumentAsk, setInstrumentAsk] = useState<InstrumentAsk | null>(null);
  const instrumentAskApi = useMemo(
    () => ({
      ask: instrumentAsk,
      open: (next: InstrumentAsk) => {
        setInstrumentAsk(next);
        navigate('instruments');
      },
      clear: () => setInstrumentAsk(null),
    }),
    [instrumentAsk, navigate]
  );

  // On a phone the Ask box is a sheet opened from the top bar, on the screens that had the box (Home, Reports) and on Analytics, which shows the search.
  const phone = useMediaQuery(PHONE_QUERY);
  const [askOpen, setAskOpen] = useState(false);
  const askAvailable = phone && (view === 'home' || view === 'reports' || view === 'analytics');


  // Back, Forward, or an edited address.
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash;
      if (hash === shownHash.current) return; // navigate() already moved the app there
      const previous = shownHash.current;
      const next = parseHash(hash);
      requestLeave(
        () => {
          shownHash.current = hash;
          if (next.view !== 'templates') setTemplateRequest(null);
          setRoute(next);
        },
        // Staying puts the address bar back where the screen still is.
        { target: next.view, revert: () => window.history.replaceState(null, '', previous || '#/') }
      );
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [requestLeave]);

  const guardApi = useMemo(
    () => ({
      setGuard: (guard: LeaveGuard | null) => {
        guardRef.current = guard;
      },
      confirmLeave: (leave: () => void, message?: string) => requestLeave(leave, { message }),
    }),
    [requestLeave]
  );

  async function saveAndLeave() {
    const pending = pendingLeave;
    if (!pending) return;
    setLeaveSaving(true);
    const saved = (await guardRef.current?.save()) ?? false;
    setLeaveSaving(false);
    setPendingLeave(null);
    // A failed save is shown on the screen itself, which is why the person stays.
    if (saved) pending.run();
    else pending.revert?.();
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
    <KeptSearchProvider>
    <InstrumentAskContext.Provider value={instrumentAskApi}>
    <NavigationGuardContext.Provider value={guardApi}>
    <div className="wrap">
      <header className="topbar">
        <button type="button" className="masthead masthead-link" data-testid="masthead-home" aria-label="ServiceLedger, go to Home" onClick={() => selectView('home')}>
          <span className="mark" /> ServiceLedger
        </button>
        <nav className="view-tabs" aria-label="Main">
          {/* Wide screens only: on a phone the five-tab bar is full, so Home is the first item of More. */}
          <button className={`view-tab tab-wide-only ${view === 'home' ? 'active' : ''}`} data-testid="tab-home" aria-current={view === 'home' ? 'page' : undefined} onClick={() => selectView('home')}>
            <TabIcon name="home" />
            <span className="tab-label">Home</span>
          </button>
          <button className={`view-tab ${view === 'new' || view === 'batch' ? 'active' : ''}`} data-testid="tab-new" aria-current={view === 'new' || view === 'batch' ? 'page' : undefined} onClick={() => selectView('new')}>
            <TabIcon name="new" />
            <span className="tab-label">New report</span>
          </button>
          <button className={`view-tab ${view === 'reports' ? 'active' : ''}`} data-testid="tab-reports" aria-current={view === 'reports' ? 'page' : undefined} onClick={() => selectView('reports')}>
            <TabIcon name="reports" />
            <span className="tab-label">Reports</span>
          </button>
          <button className={`view-tab ${view === 'analytics' ? 'active' : ''}`} data-testid="tab-analytics" aria-current={view === 'analytics' ? 'page' : undefined} onClick={() => selectView('analytics')}>
            <TabIcon name="analytics" />
            <span className="tab-label">Analytics</span>
          </button>
          <button className={`view-tab tab-wide-only ${view === 'templates' ? 'active' : ''}`} data-testid="tab-templates" aria-current={view === 'templates' ? 'page' : undefined} onClick={() => selectView('templates')}>
            <TabIcon name="templates" />
            <span className="tab-label">Templates</span>
          </button>
          <button className={`view-tab ${view === 'instruments' ? 'active' : ''}`} data-testid="tab-instruments" aria-current={view === 'instruments' ? 'page' : undefined} onClick={() => selectView('instruments')}>
            <TabIcon name="instruments" />
            <span className="tab-label">Instruments</span>
          </button>
          <button className={`view-tab tab-phone-only ${view === 'more' ? 'active' : ''} ${view === 'templates' || view === 'admin' ? 'within' : ''}`} data-testid="tab-more" aria-current={view === 'more' ? 'page' : undefined} onClick={() => selectView('more')}>
            <TabIcon name="more" />
            <span className="tab-label">More</span>
          </button>
          <button className={`view-tab tab-wide-only tab-end ${view === 'admin' ? 'active' : ''}`} data-testid="tab-admin" aria-current={view === 'admin' ? 'page' : undefined} onClick={() => selectView('admin')}>
            <span className="tab-label">Admin</span>
          </button>
        </nav>
        {view !== 'new' && (
          <button className="btn primary topbar-new" data-testid="topbar-new-report" onClick={() => selectView('new')}>
            + New report
          </button>
        )}
        {askAvailable && <AskSheetButton onOpen={() => setAskOpen(true)} />}
        <ThemeToggle />
      </header>

      <ActiveSearchLine view={view} />
      {askAvailable && askOpen && (
        <AskSheet
          onClose={() => setAskOpen(false)}
          onApply={(filters) => {
            // Reports and Analytics follow the kept search by themselves; Home opens Reports with it.
            if (view === 'home') {
              setHomeFilters(filters);
              navigate('reports');
            }
          }}
        />
      )}

      <ToastHost />

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
                navigate('templates', '', { force: true });
              }}
              onOpenBatch={() => navigate('batch')}
              onOpenReport={(reportId) => navigate('reports', reportId)}
              onViewInstrument={(instrumentId) => navigate('reports', `instrument/${instrumentId}`)}
              onCancel={() => setIntakeKey((k) => k + 1)}
            />
          </div>
        )}
        {(view === 'batch' || batchOpened) && (
          <div hidden={view !== 'batch'}>
            <BatchIntake active={view === 'batch'} incoming={incomingFiles} onOpenReport={(reportId) => navigate('reports', reportId)} onBack={() => navigate('new')} />
          </div>
        )}
        {view === 'home' && (
          <HomeScreen
            instruments={instruments}
            instrumentsLoading={instrumentsLoading}
            onOpenReport={(reportId) => navigate('reports', reportId)}
            onOpenInstrument={(instrumentId) => navigate('reports', `instrument/${instrumentId}`)}
            onNewReport={() => selectView('new')}
            onOpenReports={() => selectView('reports')}
            onOpenInstruments={() => selectView('instruments')}
            onAsk={(filters) => {
              setHomeFilters(filters);
              navigate('reports');
            }}
            onFiles={(files) => {
              setIncomingFiles((prev) => ({ files, nonce: (prev?.nonce ?? 0) + 1 }));
              navigate('batch');
            }}
          />
        )}
        {view === 'analytics' && (
          <KeptSearchGate>
            <AnalyticsScreen />
          </KeptSearchGate>
        )}
        {view === 'admin' && <AdminScreen instruments={instruments} section={route.sub} onSection={(sub) => navigate('admin', sub)} />}
        {view === 'more' && (
          <nav className="more-screen" aria-label="More" data-testid="more-screen">
            <h1 className="more-title">More</h1>
            <button type="button" className="more-item" onClick={() => selectView('home')}>
              <span><strong>Home</strong><small>What needs your attention</small></span>
            </button>
            <button type="button" className="more-item" onClick={() => selectView('templates')}>
              <span><strong>Templates</strong><small>What we read from each report type</small></span>
            </button>
            <button type="button" className="more-item" onClick={() => selectView('admin')}>
              <span><strong>Admin</strong><small>Data export, field aliases</small></span>
            </button>
          </nav>
        )}
        {view === 'templates' && (
          <TemplateManagerScreen
            knownModels={[...new Set(instruments.map((i) => i.model))].sort()}
            request={templateRequest}
            onRequestClose={(saved) => {
              setTemplateRequest(null);
              // Saved or cancelled, the waiting report is on the New report tab:
              // after a save it reads itself again with the new template.
              if (saved) setTemplateCreated({ template: saved, nonce: Date.now() });
              navigate('new', '', { force: true });
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
          <KeptSearchGate>
            <ReportsListScreen
              instruments={instruments}
              fieldConfidenceThreshold={config.field_confidence_threshold}
              path={route.sub}
              onPath={(sub) => navigate('reports', sub)}
              initialFilters={homeFilters ?? undefined}
              onInitialFiltersUsed={() => setHomeFilters(null)}
            />
          </KeptSearchGate>
        )}
      </div>

      {pendingLeave && (
        <UnsavedChangesDialog
          message={pendingLeave.message}
          busy={leaveSaving}
          onStay={() => {
            pendingLeave.revert?.();
            setPendingLeave(null);
          }}
          onDiscard={() => {
            const run = pendingLeave.run;
            setPendingLeave(null);
            run();
          }}
          onSave={() => void saveAndLeave()}
        />
      )}
    </div>
    </NavigationGuardContext.Provider>
    </InstrumentAskContext.Provider>
    </KeptSearchProvider>
  );
}
