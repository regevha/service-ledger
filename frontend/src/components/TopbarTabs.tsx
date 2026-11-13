import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PHONE_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { visibleTabCount } from '../topbarOverflow';

type IconName = 'home' | 'new' | 'reports' | 'analytics' | 'templates' | 'instruments' | 'more';

export type TabTarget = 'home' | 'new' | 'reports' | 'analytics' | 'templates' | 'instruments' | 'admin' | 'more';

// Small outline icons for the phone's bottom bar (hidden on wide screens, where the tabs are text only).
function TabIcon({ name }: { name: IconName }) {
  const common = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, className: 'tab-icon' };
  switch (name) {
    case 'home':
      return (<svg {...common}><path d="M4 11l8-7 8 7v9H4z" /><path d="M10 20v-6h4v6" /></svg>);
    case 'new':
      return (<svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></svg>);
    case 'reports':
      return (<svg {...common}><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></svg>);
    case 'analytics':
      return (<svg {...common}><path d="M4 20V10M10 20V4M16 20v-8M22 20H2" /></svg>);
    case 'templates':
      return (<svg {...common}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 10h16M10 10v10" /></svg>);
    case 'more':
      return (<svg {...common}><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></svg>);
    case 'instruments':
      return (<svg {...common}><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" /><path d="M8 15h8" /></svg>);
  }
}

type Tab = { id: Exclude<TabTarget, 'more'>; label: string; icon?: IconName; wideOnly: boolean; isActive: (view: string) => boolean };

// In row order. On a phone only the tabs without `wideOnly` show, plus the phone's own More tab.
const TABS: Tab[] = [
  { id: 'home', label: 'Home', icon: 'home', wideOnly: true, isActive: (v) => v === 'home' },
  { id: 'new', label: 'New report', icon: 'new', wideOnly: false, isActive: (v) => v === 'new' || v === 'batch' },
  { id: 'reports', label: 'Reports', icon: 'reports', wideOnly: false, isActive: (v) => v === 'reports' },
  { id: 'analytics', label: 'Analytics', icon: 'analytics', wideOnly: false, isActive: (v) => v === 'analytics' },
  { id: 'templates', label: 'Templates', icon: 'templates', wideOnly: true, isActive: (v) => v === 'templates' },
  { id: 'instruments', label: 'Instruments', icon: 'instruments', wideOnly: false, isActive: (v) => v === 'instruments' },
  { id: 'admin', label: 'Admin', wideOnly: true, isActive: (v) => v === 'admin' },
];

/**
 * The top bar's view tabs. On desktop and tablet widths the tabs that do not fit leave from the right,
 * one at a time, into a "More" menu. A phone keeps its bottom tab bar and its own More tab.
 * Tabs that do not fit stay in the page (invisible, out of the row) so they can still be measured.
 */
export function TopbarTabs({ view, onSelect }: { view: string; onSelect: (view: TabTarget) => void }) {
  const phone = useMediaQuery(PHONE_QUERY);
  const navRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [visible, setVisible] = useState(TABS.length);
  const [open, setOpen] = useState(false);

  const measure = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const widths = TABS.map((t) => tabRefs.current[t.id]?.offsetWidth ?? 0);
    const moreWidth = moreRef.current?.offsetWidth || 90;
    const gap = parseFloat(getComputedStyle(nav).columnGap) || 0;
    setVisible(visibleTabCount(widths, nav.clientWidth, moreWidth, gap));
  }, []);

  // The observer reports once when it starts and again on every size change of the row or the window.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(nav);
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, [measure]);

  // Text is wider or narrower once the web font arrives.
  useEffect(() => {
    let cancelled = false;
    const fonts = document.fonts;
    if (!fonts) return;
    const again = () => {
      if (!cancelled) measure();
    };
    void fonts.ready.then(again);
    fonts.addEventListener?.('loadingdone', again);
    return () => {
      cancelled = true;
      fonts.removeEventListener?.('loadingdone', again);
    };
  }, [measure]);

  const shown = phone ? TABS.length : visible;
  const hidden = TABS.slice(shown);
  const moreActive = hidden.some((t) => t.isActive(view));
  const menuOpen = open && hidden.length > 0 && !phone;

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || moreRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const choose = (id: TabTarget) => {
    setOpen(false);
    onSelect(id);
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      moreRef.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  return (
    <nav className="view-tabs" aria-label="Main" ref={navRef}>
      {TABS.map((t, i) => {
        const active = t.isActive(view);
        const out = !phone && i >= shown;
        return (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            className={`view-tab ${t.wideOnly ? 'tab-wide-only' : ''} ${t.id === 'admin' ? 'tab-end' : ''} ${active ? 'active' : ''} ${out ? 'tab-overflowed' : ''}`}
            data-testid={`tab-${t.id}`}
            aria-current={active ? 'page' : undefined}
            tabIndex={out ? -1 : undefined}
            onClick={() => onSelect(t.id)}
          >
            {t.icon && <TabIcon name={t.icon} />}
            <span className="tab-label">{t.label}</span>
          </button>
        );
      })}
      {/* The phone's own More tab: opens the More screen. */}
      <button className={`view-tab tab-phone-only ${view === 'more' ? 'active' : ''} ${view === 'templates' || view === 'admin' ? 'within' : ''}`} data-testid="tab-more" aria-current={view === 'more' ? 'page' : undefined} onClick={() => onSelect('more')}>
        <TabIcon name="more" />
        <span className="tab-label">More</span>
      </button>
      <div className={`topbar-more ${hidden.length === 0 || phone ? 'topbar-more-idle' : ''}`}>
        <button
          ref={moreRef}
          type="button"
          className={`view-tab topbar-more-button ${moreActive ? 'active' : ''}`}
          data-testid="topbar-more"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          tabIndex={hidden.length === 0 || phone ? -1 : undefined}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && !menuOpen) {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          <span className="tab-label">More</span>
          <span className="topbar-more-caret" aria-hidden="true">▾</span>
        </button>
        {menuOpen && (
          <div className="topbar-more-menu" role="menu" aria-label="More views" ref={menuRef} onKeyDown={onMenuKey}>
            {hidden.map((t) => (
              <button key={t.id} type="button" role="menuitem" className="topbar-more-item" data-testid={`more-item-${t.id}`} aria-current={t.isActive(view) ? 'page' : undefined} onClick={() => choose(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}
