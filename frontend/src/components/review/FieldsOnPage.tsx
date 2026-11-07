import { useEffect, useRef, useState } from 'react';
import { attachmentPageUrl } from '../../api';
import { useFieldLocations } from '../../hooks/useFieldLocations';
import { MARK_LABEL, type FieldMark } from '../../reviewMarks';

const IMAGE_WIDTH = 1100;

/**
 * The document as page images with every field drawn where its value was read: a box in the colour of the
 * field's state, named when it is pointed at. Pointing at a field in the list lights its box and, when the field
 * is focused, scrolls the page to it; clicking a box goes to the field. A field whose place is not known has no
 * box (the list says so next to it), and a scan or photo, which has no text to search, shows its pages plain.
 */
export function FieldsOnPage({
  attachmentId,
  marks,
  labels,
  active,
  reveal,
  onHover,
  onPick,
}: {
  attachmentId: string;
  /** The state of each field that can be drawn, by field name. */
  marks: Record<string, FieldMark>;
  labels: Record<string, string>;
  active: string | null;
  /** Scroll the active field's box into view (true when it was focused in the list, false when only hovered). */
  reveal: boolean;
  onHover: (name: string | null) => void;
  onPick: (name: string) => void;
}) {
  const { locations, pages, loading } = useFieldLocations(attachmentId);
  const pane = useRef<HTMLDivElement>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (!active || !reveal) return;
    const box = pane.current?.querySelector<HTMLElement>(`[data-box="${CSS.escape(active)}"]`);
    const el = pane.current;
    if (!box || !el) return;
    const b = box.getBoundingClientRect();
    const p = el.getBoundingClientRect();
    if (b.top < p.top + 40 || b.bottom > p.bottom - 40) {
      el.scrollTo({ top: el.scrollTop + (b.top - p.top) - p.height / 3, behavior: 'smooth' });
    }
  }, [active, reveal]);

  const placed = locations ? Object.keys(locations.fields).length : 0;
  const note = loading
    ? 'Finding the fields on the page…'
    : locations === null
      ? 'The positions could not be loaded, so the pages are shown without the fields.'
      : !locations.has_text
        ? placed > 0
          ? 'This is a scan or photo, so the boxes are where the reading says it found each value. They are approximate and may be a little off.'
          : 'This is a scan or photo with no recorded positions, so the fields cannot be drawn on it. Reports read from now on keep them.'
        : placed === 0
          ? 'None of the values could be found on the page.'
          : null;

  return (
    <div className="fop" data-testid="fields-on-page">
      <div className="fop-legend" aria-label="What the colours mean">
        {(['ok', 'flag', 'changed'] as FieldMark[]).map((m) => (
          <span key={m} className="fop-key">
            <i className={`fop-swatch ${m}`} aria-hidden="true" />
            {MARK_LABEL[m]}
          </span>
        ))}
      </div>
      {note && <div className="fop-note" data-testid="fields-on-page-note">{note}</div>}
      <div className="fop-pages" ref={pane}>
        {Array.from({ length: Math.max(pages, 1) }, (_, i) => i + 1).map((page) => (
          <div className="fop-page" key={page} data-page={page}>
            <img
              src={attachmentPageUrl(attachmentId, page, IMAGE_WIDTH)}
              alt={`Page ${page} of the original`}
              onError={() => setBroken(true)}
            />
            {locations &&
              Object.entries(locations.fields)
                .filter(([, loc]) => loc.page === page)
                .map(([name, loc]) =>
                  loc.rects.map((r, k) => (
                    <button
                      key={`${name}-${k}`}
                      type="button"
                      data-box={name}
                      className={`fop-box ${marks[name] ?? 'ok'}${active === name ? ' active' : ''}${loc.ambiguous || loc.source === 'model' ? ' guess' : ''}`}
                      style={{ left: `${(r.x - 0.004) * 100}%`, top: `${(r.y - 0.003) * 100}%`, width: `${(r.w + 0.008) * 100}%`, height: `${(r.h + 0.006) * 100}%` }}
                      aria-label={`${labels[name] ?? name}${loc.ambiguous || loc.source === 'model' ? ' (position is approximate)' : ''}`}
                      title={`${labels[name] ?? name}${loc.source === 'model' ? ': approximate position' : loc.ambiguous ? ': this text is on the page more than once, so the spot may be a different one' : ''}`}
                      onMouseEnter={() => onHover(name)}
                      onMouseLeave={() => onHover(null)}
                      onClick={() => onPick(name)}
                    >
                      {k === 0 && <span className="fop-name">{labels[name] ?? name}</span>}
                    </button>
                  )),
                )}
          </div>
        ))}
        {broken && <div className="fop-note">A page could not be shown.</div>}
      </div>
    </div>
  );
}
