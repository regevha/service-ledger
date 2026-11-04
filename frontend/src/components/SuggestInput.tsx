import { useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'list'> & {
  value: string;
  onChange: (value: string) => void;
  /** Names already on file. Tapping one fills the box. */
  options: string[];
};

/**
 * A text box that offers the names already on file as tappable chips under it while it has focus.
 * The browser's own `<datalist>` does not open on a tap in Chrome for Android, so on a phone the
 * institutes and rooms on record were invisible. Anything can still be typed: a name that is not
 * listed becomes a new one, as before.
 */
export function SuggestInput({ value, onChange, options, onFocus, onBlur, ...inputProps }: Props) {
  const [open, setOpen] = useState(false);
  const typed = value.trim().toLowerCase();
  const shown = [...new Set(options)]
    .filter((o) => o.trim().toLowerCase() !== typed && o.toLowerCase().includes(typed))
    .slice(0, 40);
  return (
    <span className="suggest-wrap">
      <input
        {...inputProps}
        type="text"
        value={value}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => {
          setOpen(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setOpen(false);
          onBlur?.(e);
        }}
      />
      {open && shown.length > 0 && (
        <span className="suggest-list" aria-hidden="true">
          {shown.map((name) => (
            <button
              key={name}
              type="button"
              tabIndex={-1}
              className="suggest-chip"
              // Keep focus in the box, so the list does not close before the tap lands.
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(name);
                setOpen(false);
              }}
            >
              {name}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
