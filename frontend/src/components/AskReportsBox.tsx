import { useEffect, useRef, useState } from 'react';
import { ApiError, parseReportSearch, type ReportFilters, type ReportSearchPart } from '../api';
import { useKeptSearch } from '../keptSearchContext';

const EXAMPLES = ['repairs of the FACSAria III last month', 'waiting for review', 'maintenance in 2025 at Bar-Ilan University'];

/**
 * One text box above the filters: "repairs of the FACSAria III last month". The server turns the sentence into the
 * same filters the bar below holds, so the person sees what was understood and can change any of it there. It
 * never searches by itself: it only fills the filters.
 *
 * The last search that set anything is kept (see keptSearch.ts) until the person asks again or changes the
 * filters, so the box shows it again when the screen is opened later, here or on another screen.
 */
export function AskReportsBox({
  onApply,
  showUnderstood = true,
  label = 'Ask in plain words',
  placeholder = 'repairs of the FACSAria III last month',
  submitLabel = 'Show',
}: {
  onApply: (filters: ReportFilters) => void;
  /** False where the filters are applied on another screen, so there is nothing to show underneath. */
  showUnderstood?: boolean;
  label?: string;
  placeholder?: string;
  submitLabel?: string;
}) {
  const { kept, notice, save, dismissNotice } = useKeptSearch();
  const [text, setText] = useState(kept?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [understood, setUnderstood] = useState<ReportSearchPart[] | null>(kept?.understood ?? null);
  const [error, setError] = useState<string | null>(null);

  // The kept search can change after this box opened (the check at startup drops one whose instrument is gone).
  // Until the person types or asks, the box follows it.
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) return;
    setText(kept?.text ?? '');
    setUnderstood(kept?.understood ?? null);
  }, [kept]);

  async function ask(request: string) {
    const trimmed = request.trim();
    if (!trimmed) return;
    touched.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await parseReportSearch(trimmed);
      setUnderstood(result.understood);
      // Kept before it is applied, so the screen that receives the filters already finds them in the kept search.
      save({ text: trimmed, filters: result.filters, understood: result.understood });
      onApply(result.filters);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not read that. Try the filters below.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="ask-box"
      data-testid="ask-box"
      onSubmit={(e) => {
        e.preventDefault();
        void ask(text);
      }}
    >
      <label className="ask-label" htmlFor="ask-reports-input">
        {label}
      </label>
      <div className="ask-row">
        <input
          id="ask-reports-input"
          type="text"
          className="ask-input"
          data-testid="ask-input"
          value={text}
          maxLength={300}
          placeholder={placeholder}
          onChange={(e) => {
            touched.current = true;
            setText(e.target.value);
          }}
        />
        <button type="submit" className="btn primary" data-testid="ask-submit" disabled={busy || !text.trim()}>
          {busy ? 'Reading…' : submitLabel}
        </button>
      </div>
      {notice && (
        <div className="banner banner-info" role="status" data-testid="kept-search-notice">
          {notice}{' '}
          <button type="button" className="link-button" onClick={dismissNotice}>
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <div className="banner banner-warn" role="alert">
          {error}
        </div>
      )}
      {(understood === null || !showUnderstood) && !error && (
        <div className="ask-examples">
          Try:{' '}
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="link-button"
              onClick={() => {
                setText(example);
                void ask(example);
              }}
            >
              {example}
            </button>
          ))}
        </div>
      )}
      {understood !== null && showUnderstood && (
        <div className="ask-understood" data-testid="ask-understood" aria-live="polite">
          {understood.length === 0 ? (
            <span>Nothing in that matched a filter, so all reports are shown.</span>
          ) : (
            <>
              <span>Showing</span>
              {understood.map((part) => (
                <span key={part.key} className="ask-chip" data-testid="ask-chip">
                  {part.label}
                </span>
              ))}
              <span className="ask-hint">Change any of it in the filters below.</span>
            </>
          )}
        </div>
      )}
    </form>
  );
}
