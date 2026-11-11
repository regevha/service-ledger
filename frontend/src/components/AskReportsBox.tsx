import { useEffect, useRef, useState } from 'react';
import { ApiError, parseReportSearch, type ReportFilters, type ReportSearchResult } from '../api';
import { ActiveSearchChips } from './ActiveSearch';
import { useKeptSearch } from '../keptSearchContext';
import { PHONE_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { addRecent, readRecent, writeRecent } from '../recentSearches';
import { instrumentAskOf } from '../instrumentAsk';
import { useInstrumentAsk } from '../instrumentAskContext';
import { listen, PROBLEM_TEXT, speechSupported, type VoiceProblem } from '../speech';

const EXAMPLES = ['repairs of the FACSAria III last month', 'waiting for review', 'maintenance in 2025 at Bar-Ilan University'];

/**
 * One text box above the filters: "repairs of the FACSAria III last month". The server turns the sentence into the
 * same filters the bar below holds, so the person sees what was understood and can change any of it there. It
 * never searches by itself: it only fills the filters.
 *
 * The last search that set anything is kept (see keptSearch.ts) until the person asks again or changes the
 * filters, so the box shows it again when the screen is opened later, here or on another screen.
 *
 * On a phone the box does not sit in the page (it would fill the top third of the screen): the magnifier in the
 * top bar opens it in a sheet (AskSheet), where `inSheet` is set. Everywhere else it stays where it is.
 */
export function AskReportsBox({
  onApply,
  showUnderstood = true,
  label = 'Ask in plain words',
  placeholder = 'repairs of the FACSAria III last month',
  submitLabel = 'Show',
  inSheet = false,
  onDone,
}: {
  onApply: (filters: ReportFilters) => void;
  /** False where the filters are applied on another screen, so there is nothing to show underneath. */
  showUnderstood?: boolean;
  label?: string;
  placeholder?: string;
  submitLabel?: string;
  /** True for the copy inside the phone sheet. */
  inSheet?: boolean;
  /** Called after a question that set something was applied, so the sheet can close. */
  onDone?: () => void;
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const instrumentAsk = useInstrumentAsk();
  const { kept, notice, save, dismissNotice } = useKeptSearch();
  const [text, setText] = useState(kept?.text ?? '');
  const [busy, setBusy] = useState(false);
  // True when the last question set nothing, so it is not kept and there are no chips to show for it.
  const [nothingMatched, setNothingMatched] = useState(false);
  // How the last question was read: by the built-in rules or with a small AI model, and what could not be applied.
  const [details, setDetails] = useState<Pick<ReportSearchResult, 'source' | 'notes'>>({ source: 'rules', notes: [] });
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState(readRecent);
  // Speaking the question: whether the microphone is on, and why the last try gave nothing.
  const [listening, setListening] = useState(false);
  const [voiceProblem, setVoiceProblem] = useState<VoiceProblem | null>(null);
  const stopListening = useRef<(() => void) | null>(null);
  const canSpeak = speechSupported();
  useEffect(() => () => stopListening.current?.(), []);

  // The kept search can change after this box opened (the check at startup drops one whose instrument is gone).
  // Until the person types or asks, the box follows it.
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) return;
    setText(kept?.text ?? '');
  }, [kept]);

  async function ask(request: string) {
    const trimmed = request.trim();
    if (!trimmed) return;
    touched.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await parseReportSearch(trimmed);
      // A question about instruments is answered on the Instruments tab, so it is neither kept nor applied here.
      const forInstruments = instrumentAskOf(result);
      if (forInstruments && instrumentAsk) {
        setNothingMatched(false);
        const next = addRecent(readRecent(), trimmed);
        writeRecent(next);
        setRecent(next);
        instrumentAsk.open(forInstruments);
        onDone?.();
        return;
      }
      setNothingMatched(result.understood.length === 0);
      setDetails({ source: result.source, notes: result.notes ?? [] });
      // Kept before it is applied, so the screen that receives the filters already finds them in the kept search.
      save({ text: trimmed, filters: result.filters, understood: result.understood });
      onApply(result.filters);
      if (result.understood.length > 0) {
        const next = addRecent(readRecent(), trimmed);
        writeRecent(next);
        setRecent(next);
        onDone?.();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not read that. Try the filters below.');
    } finally {
      setBusy(false);
    }
  }

  function toggleVoice() {
    if (listening) {
      stopListening.current?.();
      return;
    }
    setVoiceProblem(null);
    setError(null);
    setListening(true);
    stopListening.current = listen({
      onText: (spoken) => {
        touched.current = true;
        setText(spoken);
        void ask(spoken);
      },
      onProblem: setVoiceProblem,
      onEnd: () => {
        setListening(false);
        stopListening.current = null;
      },
    });
    if (!stopListening.current) setListening(false);
  }

  // On a phone the page has no box; only the notice about a dropped search still needs somewhere to show.
  if (phone && !inSheet) {
    return notice ? (
      <div className="banner banner-info" role="status" data-testid="kept-search-notice">
        {notice}{' '}
        <button type="button" className="link-button" onClick={dismissNotice}>
          Dismiss
        </button>
      </div>
    ) : null;
  }

  const recentToShow = recent.filter((item) => item !== kept?.text);

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
        {canSpeak && (
          <button
            type="button"
            className={`btn ask-voice${listening ? ' listening' : ''}`}
            data-testid="ask-voice"
            aria-label={listening ? 'Stop listening' : 'Speak your question'}
            aria-pressed={listening}
            disabled={busy}
            onClick={toggleVoice}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <rect x="6" y="1.5" width="4" height="8" rx="2" fill="currentColor" />
              <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <button type="submit" className="btn primary" data-testid="ask-submit" disabled={busy || !text.trim()}>
          {busy ? 'Reading…' : submitLabel}
        </button>
      </div>
      {listening && (
        <div className="ask-voice-status" role="status" data-testid="ask-voice-status">
          Listening… say the question.
        </div>
      )}
      {voiceProblem && !listening && (
        <div className="banner banner-warn" role="alert" data-testid="ask-voice-problem">
          {PROBLEM_TEXT[voiceProblem]}
        </div>
      )}
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
      {recentToShow.length > 0 && !error && (
        <div className="ask-recent" data-testid="ask-recent">
          Recent:{' '}
          {recentToShow.map((item) => (
            <button
              key={item}
              type="button"
              className="link-button"
              data-testid="ask-recent-item"
              onClick={() => {
                touched.current = true;
                setText(item);
                void ask(item);
              }}
            >
              {item}
            </button>
          ))}
        </div>
      )}
      {!(showUnderstood && (kept || nothingMatched)) && !error && (
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
      {showUnderstood && (kept || nothingMatched) && (
        <div className="ask-understood" data-testid="ask-understood" aria-live="polite">
          {kept ? (
            <div className="ask-conditions">
              <span>Showing</span>
              <ActiveSearchChips chipTestId="ask-chip" clearTestId="ask-clear" />
              {details.source === 'ai' && (
                <span className="ask-badge" data-testid="ask-ai-badge" title="The built-in rules could not read all of it, so a small AI model helped.">
                  Read with AI
                </span>
              )}
              <span className="ask-hint">Tap a condition to remove it, or change it in the filters below.</span>
            </div>
          ) : (
            <span>Nothing in that matched a filter, so all reports are shown.</span>
          )}
          {details.notes.length > 0 && (
            <div className="ask-notes" data-testid="ask-notes">
              Not supported yet, so not applied: {details.notes.join(', ')}.
            </div>
          )}
        </div>
      )}
    </form>
  );
}
