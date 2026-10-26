import { useState, type ReactNode } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';

/**
 * One chart on the Analytics page. On a phone its title is a button that opens and closes it, so the
 * page is a short list of headings rather than one long scroll; elsewhere it is always open.
 */
export function ChartSection({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const phone = useMediaQuery('(max-width: 620px)');
  const [open, setOpen] = useState(defaultOpen);
  if (!phone) {
    return (
      <div className="chart-section">
        <div className="chart-title">{title}</div>
        {children}
      </div>
    );
  }
  return (
    <div className={`chart-section chart-section-fold${open ? ' chart-section-open' : ''}`}>
      <button type="button" className="chart-title chart-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && children}
    </div>
  );
}
