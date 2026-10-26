import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A banner. On a phone a long one shows its first two lines and a "More" button, so several notices
 * above a form do not push the form off the first screen; elsewhere it looks exactly like a plain banner.
 * `actions` (buttons the notice offers) always stay visible.
 */
export function Notice({
  tone,
  id,
  children,
  actions,
}: {
  tone: 'info' | 'warn' | 'crit';
  id?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const text = useRef<HTMLDivElement>(null);

  // Is there more text than the two visible lines? Only then is "More" worth showing.
  useLayoutEffect(() => {
    const el = text.current;
    if (!el || open) return;
    setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [children, open]);

  return (
    <div className={`banner banner-${tone} notice${open ? ' notice-open' : ''}`} id={id}>
      <div className="notice-text" ref={text}>
        {children}
      </div>
      {(clipped || open) && (
        <button type="button" className="link-button notice-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'More'}
        </button>
      )}
      {actions}
    </div>
  );
}
