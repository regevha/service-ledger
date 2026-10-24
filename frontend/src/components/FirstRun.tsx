import { useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { useFirstRun, workerLooksDown } from '../firstRun';

/**
 * The first-run pieces of the screens: the empty state every empty screen
 * shows (what is missing and the two ways to fix it), and the two notices
 * under the tabs. The state they read lives in src/firstRun.ts.
 */

function describe(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

/**
 * The empty state of a screen: what is missing, and the two ways to fix it.
 * Keeps the `empty-hint` class, which the older plain "No X yet." lines had.
 */
export function EmptyState({
  title,
  children,
  upload = true,
  demo = true,
}: {
  title: string;
  children: ReactNode;
  /** Offer "Upload your first report". */
  upload?: boolean;
  /** Offer "Load demo data" (hidden when there is no instrument to attach it to). */
  demo?: boolean;
}) {
  const { status, goTo, loadDemo } = useFirstRun();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canLoadDemo = demo && (status === null || status.instruments > 0);

  async function onLoadDemo() {
    setBusy(true);
    setError(null);
    try {
      await loadDemo();
    } catch (e) {
      setError(describe(e, 'Could not load the demo data.'));
      setBusy(false);
    }
    // On success the app reloads this screen with data in it, which replaces this component.
  }

  return (
    <div className="empty-hint empty-state" data-testid="empty-state">
      <div className="empty-state-title">{title}</div>
      <p>{children}</p>
      {(upload || canLoadDemo) && (
        <div className="cta-row">
          {upload && (
            <button type="button" className="btn primary" onClick={() => goTo('new')}>
              Upload your first report
            </button>
          )}
          {canLoadDemo && (
            <button type="button" className="btn" disabled={busy} onClick={() => void onLoadDemo()}>
              {busy ? 'Loading demo data…' : 'Load demo data'}
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="banner banner-warn" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** The two notices under the tabs: demo data on screen, and a worker that is not running. */
export function FirstRunBanners() {
  const { status, removeDemo } = useFirstRun();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRemove() {
    setRemoving(true);
    setError(null);
    try {
      await removeDemo();
    } catch (e) {
      setError(describe(e, 'Could not remove the demo data.'));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      {workerLooksDown(status) && (
        <div className="banner banner-warn" id="worker-banner" role="status">
          Uploads are waiting for the background worker, and it does not look like it is running. Start it with{' '}
          <code>python -m app.worker</code> (or run everything with <code>docker compose up</code>). This message clears by
          itself once it is.
        </div>
      )}
      {status !== null && status.demo_reports > 0 && (
        <div className="banner banner-info" id="demo-banner">
          <div>
            You are looking at demo data ({status.demo_reports} sample report{status.demo_reports === 1 ? '' : 's'}). Your own
            reports are not affected.
          </div>
          <div className="banner-actions">
            <button type="button" className="btn small" disabled={removing} onClick={() => void onRemove()}>
              {removing ? 'Removing…' : 'Remove demo data'}
            </button>
          </div>
          {error && <div role="alert">{error}</div>}
        </div>
      )}
    </>
  );
}
