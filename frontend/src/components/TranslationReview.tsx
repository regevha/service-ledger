import { useMemo, useState } from 'react';
import type { Translation } from '../api';
import { findDurations } from '../durations';

/**
 * The review checkpoint for a translated document (docs: proposal-hebrew-
 * translation.md). The original sits beside the English text; nothing is
 * classified or extracted until a person accepts (or discards) it. The English
 * is shown here only — there is no way to download it.
 */

export function TranslationReview({
  translation,
  originalUrl,
  busy,
  onAccept,
  onDiscard,
  onTranslateAgain,
}: {
  translation: Translation;
  originalUrl: string;
  busy: boolean;
  /** `editedText` is undefined when the text was not changed. */
  onAccept: (editedText: string | undefined) => void;
  onDiscard: () => void;
  onTranslateAgain: (includePages: number[]) => void;
}) {
  const original = translation.model_text ?? '';
  const [text, setText] = useState(original);
  const edited = text !== original;
  const missing = translation.identifier_check.missing ?? [];
  const checked = translation.identifier_check.checked ?? 0;
  const durations = useMemo(() => findDurations(text), [text]);
  const blank = text.trim() === '';

  return (
    <div className="section" id="translation-review">
      <div className="section-title">Check the English translation</div>
      <p className="hint-text">
        This document was in {translation.source_language === 'he' ? 'Hebrew' : 'another language'} (about{' '}
        {Math.round((translation.hebrew_share ?? 0) * 100)}% Hebrew letters). Read it against the original, fix anything wrong, then accept: the
        instrument, report type and fields are read from the accepted English. The English is shown here only and is not saved as a file.
      </p>

      {translation.ignored_pages.length > 0 && (
        <div className="banner banner-info" id="ignored-pages">
          <div>
            Left out of the translation (instrument QC printouts): page{translation.ignored_pages.length > 1 ? 's' : ''}{' '}
            {translation.ignored_pages.map((p) => p.page).join(', ')}. They stay in the original file.
          </div>
          <div className="cta-row" style={{ marginTop: 8 }}>
            {translation.ignored_pages.map((p) => (
              <button
                key={p.page}
                className="btn small"
                disabled={busy}
                title={p.reason}
                onClick={() => onTranslateAgain([...translation.included_pages, p.page])}
              >
                Include page {p.page}
              </button>
            ))}
          </div>
        </div>
      )}

      {translation.included_pages.length > 0 && (
        <div className="banner banner-info" id="included-pages">
          Page{translation.included_pages.length > 1 ? 's' : ''} {translation.included_pages.join(', ')} included at your request.
        </div>
      )}

      {missing.length > 0 ? (
        <div className="banner banner-warn" id="identifier-check">
          These identifiers were expected but are not in the English text exactly as printed: <b>{missing.join(', ')}</b>. Check them against the
          original{checked > 0 ? ` (${checked} identifiers checked)` : ''}.
        </div>
      ) : (
        checked > 0 && (
          <div className="banner banner-info" id="identifier-check">
            All {checked} identifiers (serial, order and part numbers, dates) appear in the English exactly as listed.
          </div>
        )
      )}

      {translation.notes.length > 0 && (
        <ul className="hint-text" id="translation-notes">
          {translation.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      <div className="translation-panes">
        <div className="translation-pane">
          <div className="clabel">Original</div>
          <iframe className="translation-original" src={originalUrl} title="Original document" />
        </div>
        <div className="translation-pane">
          <div className="clabel">English {edited && <span className="field-note">(edited)</span>}</div>
          <textarea
            className="translation-text"
            dir="ltr"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="English translation"
          />
        </div>
      </div>

      {durations.length > 0 && (
        <div className="field-note" id="translation-durations">
          Durations in the text: {durations.map((d) => `${d.printed} = ${d.hours} h`).join('; ')}. The extraction uses decimal hours.
        </div>
      )}

      <div className="cta-row">
        <button className="btn" disabled={busy} onClick={onDiscard} title="Go on with the original document, without a translation">
          Discard and use the original
        </button>
        <button className="btn" disabled={busy} onClick={() => onTranslateAgain(translation.included_pages)}>
          Translate again
        </button>
        <button className="btn primary" disabled={busy || blank} onClick={() => onAccept(edited ? text : undefined)}>
          {edited ? 'Accept my edits & continue →' : 'Accept & continue →'}
        </button>
      </div>
    </div>
  );
}
