import { useCallback, useEffect, useRef, useState } from 'react';
import { getReport } from '../api';
import { ACCEPTED_TYPES } from '../uploadFiles';
import { runItem } from '../batchRun';
import { STATE_LABEL, WORKING_STATES, runPool, stateForReportStatus, summarize, type BatchItem } from '../batchState';
import { REPORT_TYPE_LABEL } from '../labels';
import { useOnline } from '../hooks/useOnline';

// How many files are read at once. The reading itself is queued on the server's worker; a few in flight keeps
// the list moving without piling a whole folder of jobs onto it.
const LIMIT = 2;
const MAX_FILES = 30;

/**
 * Several files at once: drop them, watch each go through upload, language check, identifying and reading, and
 * check each on the normal report screen. A file is approved there, not here: this screen only shows where each
 * one stands and takes the person to the next one to check.
 */
export function BatchIntake({
  active,
  incoming,
  onOpenReport,
  onBack,
}: {
  /** Whether this screen is the one showing. It stays mounted while the person checks a report, so the list is kept. */
  active: boolean;
  /** Files handed over from Home. Each new nonce adds its files to the list (nothing is read until the person starts it). */
  incoming?: { files: File[]; nonce: number } | null;
  onOpenReport: (reportId: string) => void;
  onBack: () => void;
}) {
  const online = useOnline();
  const [items, setItems] = useState<BatchItem[]>([]);
  const [technician, setTechnician] = useState('');
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const itemsRef = useRef<BatchItem[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Files dropped on Home arrive here; each drop (a new nonce) is added once.
  const handledNonce = useRef(0);
  useEffect(() => {
    if (incoming && incoming.nonce !== handledNonce.current) {
      handledNonce.current = incoming.nonce;
      add(incoming.files);
    }
  });

  const patch = useCallback((id: number, change: Partial<BatchItem>) => {
    setItems((current) => current.map((i) => (i.id === id ? { ...i, ...change } : i)));
  }, []);

  function add(list: FileList | File[]) {
    const files = Array.from(list);
    const accepted = files.filter((f) => ACCEPTED_TYPES.includes(f.type) || (!f.type && /\.(pdf|png|jpe?g|gif|webp)$/i.test(f.name)));
    const skipped = files.length - accepted.length;
    const room = MAX_FILES - items.length;
    const taken = accepted.slice(0, Math.max(room, 0));
    const notes: string[] = [];
    if (skipped > 0) notes.push(`${skipped} ${skipped === 1 ? 'file is' : 'files are'} not a PDF or an image and was left out.`);
    if (accepted.length > taken.length) notes.push(`A batch holds ${MAX_FILES} files; the rest were left out.`);
    setProblem(notes.length > 0 ? notes.join(' ') : null);
    setItems((current) => [...current, ...taken.map((file) => ({ id: nextId.current++, file, state: 'queued' as const }))]);
  }

  async function start(only?: BatchItem[]) {
    const queue = only ?? itemsRef.current.filter((i) => i.state === 'queued');
    if (queue.length === 0) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    await runPool(queue, LIMIT, async (item) => {
      if (controller.signal.aborted) {
        patch(item.id, { state: 'failed', message: 'Stopped before it started.' });
        return;
      }
      await runItem(item.file, technician.trim() || null, (change) => patch(item.id, change), controller.signal);
    });
    abort.current = null;
    setRunning(false);
  }

  function retry(item: BatchItem) {
    patch(item.id, { state: 'queued', message: undefined, existingReportId: undefined });
    void start([{ ...item, state: 'queued' }]);
  }

  function remove(id: number) {
    setItems((current) => current.filter((i) => i.id !== id));
  }

  // Back from checking a report: the ones finalized there show as approved.
  useEffect(() => {
    if (!active) return;
    const waiting = itemsRef.current.filter((i) => i.state === 'ready' && i.reportId);
    if (waiting.length === 0) return;
    let live = true;
    void Promise.all(
      waiting.map((i) =>
        getReport(i.reportId as string)
          .then((r) => ({ id: i.id, state: stateForReportStatus(r.status) }))
          .catch(() => null)
      )
    ).then((results) => {
      if (!live) return;
      for (const r of results) if (r && r.state === 'approved') patch(r.id, { state: 'approved' });
    });
    return () => {
      live = false;
    };
  }, [active, patch]);

  const counts = summarize(items);
  const nextToCheck = items.find((i) => i.state === 'ready' && i.reportId);
  const idle = !running && items.some((i) => i.state === 'queued');

  return (
    <div className="batch" data-testid="batch-screen">
      <div className="batch-head">
        <div>
          <h1 className="batch-title">Several PDFs</h1>
          <p className="batch-sub">Each file is read on its own. You check and approve each one on its report screen.</p>
        </div>
        <button type="button" className="btn" onClick={onBack}>
          Back to New report
        </button>
      </div>

      <label
        className="batch-drop"
        data-testid="batch-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          add(e.dataTransfer.files);
        }}
      >
        <strong>Drop PDFs here, or choose them</strong>
        <span>Up to {MAX_FILES} files. Each one becomes its own report.</span>
        <input
          type="file"
          multiple
          accept={ACCEPTED_TYPES.join(',')}
          data-testid="batch-input"
          aria-label="Choose files"
          onChange={(e) => {
            if (e.target.files) add(e.target.files);
            e.target.value = '';
          }}
        />
      </label>
      {problem && (
        <div className="banner banner-warn" role="status">
          {problem}
        </div>
      )}
      {running && (
        <div className="banner banner-info" role="status" data-testid="batch-keep-open">
          {online
            ? 'Keep this tab open until every file is done. You can move around the app meanwhile; closing or reloading the tab stops the files that have not finished.'
            : 'You are offline, so files cannot be sent or read until the connection is back. Keep this tab open.'}
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="batch-bar">
            <div className="batch-counts" data-testid="batch-counts" aria-live="polite">
              <span>{counts.total} files</span>
              <span>{counts.ready} ready to check</span>
              <span>{counts.approved} approved</span>
              {counts.stopped > 0 && <span className="batch-flag">{counts.stopped} need you</span>}
            </div>
            <label className="batch-tech">
              <span>Technician</span>
              <input value={technician} onChange={(e) => setTechnician(e.target.value)} disabled={running} aria-label="Technician name" placeholder="Optional" />
            </label>
            <div className="batch-actions">
              {idle && (
                <button type="button" className="btn primary" data-testid="batch-start" onClick={() => void start()}>
                  Read {items.filter((i) => i.state === 'queued').length} {items.filter((i) => i.state === 'queued').length === 1 ? 'file' : 'files'}
                </button>
              )}
              {running && (
                <button type="button" className="btn" data-testid="batch-stop" onClick={() => abort.current?.abort()}>
                  Stop
                </button>
              )}
              {nextToCheck && (
                <button type="button" className="btn primary" data-testid="batch-next" onClick={() => onOpenReport(nextToCheck.reportId as string)}>
                  Check next
                </button>
              )}
            </div>
          </div>

          <ul className="batch-list" data-testid="batch-list">
            {items.map((item) => (
              <li key={item.id} className={`batch-row state-${item.state}`} data-testid="batch-row" data-state={item.state}>
                <div className="batch-file">
                  <span className="batch-name">{item.file.name}</span>
                  <span className="batch-detail">
                    {item.message ??
                      ([item.instrument, item.reportType ? (REPORT_TYPE_LABEL[item.reportType as keyof typeof REPORT_TYPE_LABEL] ?? item.reportType) : null].filter(Boolean).join(' · ') ||
                        `${Math.max(1, Math.round(item.file.size / 1024))} KB`)}
                  </span>
                </div>
                <span className={`batch-state${WORKING_STATES.includes(item.state) ? ' working' : ''}`} data-testid="batch-state">
                  {STATE_LABEL[item.state]}
                </span>
                <div className="batch-row-actions">
                  {item.state === 'ready' && item.reportId && (
                    <button type="button" className="btn small primary" onClick={() => onOpenReport(item.reportId as string)}>
                      Check
                    </button>
                  )}
                  {item.state === 'approved' && item.reportId && (
                    <button type="button" className="btn small" onClick={() => onOpenReport(item.reportId as string)}>
                      Open
                    </button>
                  )}
                  {item.state === 'duplicate' && item.existingReportId && (
                    <button type="button" className="btn small" onClick={() => onOpenReport(item.existingReportId as string)}>
                      Open it
                    </button>
                  )}
                  {item.state === 'failed' && (
                    <button type="button" className="btn small" onClick={() => retry(item)} disabled={running}>
                      Try again
                    </button>
                  )}
                  {(item.state === 'queued' || item.state === 'failed' || item.state === 'attention' || item.state === 'duplicate') && (
                    <button type="button" className="btn small" aria-label={`Remove ${item.file.name}`} onClick={() => remove(item.id)}>
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
