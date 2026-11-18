import { useRef, useState } from 'react';
import { formatIsoDay, isIsoDay, parseDisplayDay } from '../isoDay';

/**
 * A day-first date field, independent of the browser's locale. The text can be
 * typed or pasted; the calendar button opens the browser's own picker. A half-typed or impossible
 * date is not passed on: `onChange` only hears about a whole valid day, or '' when the box is emptied.
 */
export function DateInput({
  value,
  onChange,
  id,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  ariaLabel?: string;
  className?: string;
}) {
  // What is being typed; follows `value` whenever the outside changes it.
  const [draft, setDraft] = useState(formatIsoDay(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(formatIsoDay(value));
  }
  const picker = useRef<HTMLInputElement>(null);
  const invalid = draft !== '' && !parseDisplayDay(draft);

  function type(text: string) {
    setDraft(text);
    if (text === '') onChange('');
    else {
      const iso = parseDisplayDay(text);
      if (iso) onChange(iso);
    }
  }

  function openPicker() {
    const el = picker.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  }

  return (
    <span className={`date-input ${className ?? ''}`}>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        placeholder="DD/MM/YYYY"
        maxLength={10}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        value={draft}
        onChange={(e) => type(e.target.value.trim())}
        onBlur={() => {
          // Leaving a half-typed date puts back the last good one rather than leaving text that was never used.
          if (invalid) setDraft(formatIsoDay(value));
        }}
      />
      <button type="button" className="date-input-pick" aria-label="Open calendar" onClick={openPicker}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M2 6.5h12M5.5 1.8v2.6M10.5 1.8v2.6" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      <input
        ref={picker}
        type="date"
        className="date-input-native"
        aria-label="Calendar"
        tabIndex={-1}
        aria-hidden="true"
        value={isIsoDay(value) ? value : ''}
        onChange={(e) => {
          if (isIsoDay(e.target.value)) type(formatIsoDay(e.target.value));
        }}
      />
    </span>
  );
}
