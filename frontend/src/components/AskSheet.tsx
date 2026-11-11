import { useEffect, useRef } from 'react';
import type { ReportFilters } from '../api';
import { AskReportsBox } from './AskReportsBox';

/** The magnifier in the top bar (phones only): opens the Ask box in a sheet. */
export function AskSheetButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="ask-open" data-testid="ask-open" aria-label="Search in plain words" aria-haspopup="dialog" onClick={onOpen}>
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M13 13l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/**
 * The Ask box as a sheet over the page, for phones. It closes with Close, a tap outside it or Escape, and by
 * itself once a question has set something (the pinned line at the top then shows what it became).
 */
export function AskSheet({ onClose, onApply }: { onClose: () => void; onApply: (filters: ReportFilters) => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sheet.current?.querySelector<HTMLInputElement>('input[type="text"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="ask-sheet-backdrop"
      data-testid="ask-sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ask-sheet" role="dialog" aria-modal="true" aria-label="Ask in plain words" data-testid="ask-sheet" ref={sheet}>
        <div className="ask-sheet-head">
          <strong>Search</strong>
          <button type="button" className="link-button ask-sheet-close" data-testid="ask-sheet-close" onClick={onClose}>
            Close
          </button>
        </div>
        <AskReportsBox inSheet onApply={onApply} onDone={onClose} />
      </div>
    </div>
  );
}
