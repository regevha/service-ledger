import { useEffect, useRef, useState } from 'react';
import { attachmentPageUrl, getAttachmentPageCount } from '../api';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

/**
 * The scan as page images, for a phone: Android Chrome cannot show a PDF in an
 * iframe, so the server renders each page to a PNG. Pinch (or the +/- buttons)
 * zooms; the pane scrolls both ways when zoomed in.
 */
export function ScanPages({ attachmentId }: { attachmentId: string }) {
  const [pages, setPages] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const pane = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setPages(null);
    setError(false);
    getAttachmentPageCount(attachmentId)
      .then((r) => live && setPages(r.page_count))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [attachmentId]);

  function applyZoom(next: number) {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    zoomRef.current = z;
    setZoom(z);
  }

  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    let startDist = 0;
    let startZoom = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        startDist = dist(e.touches);
        startZoom = zoomRef.current;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && startDist > 0) {
        applyZoom(startZoom * (dist(e.touches) / startDist));
      }
    };
    const onEnd = () => {
      startDist = 0;
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
    };
  }, [pages]);

  if (error) return <div className="banner banner-warn">The scan could not be shown. Use "View original scan" instead.</div>;
  if (pages === null) {
    return (
      <div className="working-panel">
        <div className="spinner" />
        <div>Loading scan…</div>
      </div>
    );
  }

  return (
    <div className="scan-pages">
      <div className="scan-zoom-bar">
        <button type="button" className="btn small" aria-label="Zoom out" onClick={() => applyZoom(zoom - 0.5)} disabled={zoom <= MIN_ZOOM}>
          −
        </button>
        <span className="scan-zoom-level">{Math.round(zoom * 100)}%</span>
        <button type="button" className="btn small" aria-label="Zoom in" onClick={() => applyZoom(zoom + 0.5)} disabled={zoom >= MAX_ZOOM}>
          +
        </button>
      </div>
      <div className="scan-pane" ref={pane} aria-label="Original scan pages">
        <div className="scan-sheet" style={{ width: `${zoom * 100}%` }}>
          {Array.from({ length: pages }, (_, i) => (
            <img
              key={i}
              className="scan-page"
              src={attachmentPageUrl(attachmentId, i + 1, 1200)}
              alt={`Scan page ${i + 1} of ${pages}`}
              loading={i === 0 ? 'eager' : 'lazy'}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
