import type { ReactNode } from 'react';
import { ScanToggleButton, type useScanPreview } from '../ScanPreview';
import type { useReviewSearch } from '../../hooks/useReviewSearch';

/** "Extracted in 14.2 s": how long reading the document took. Under a tenth of a second (the demo reader) says so. */
function extractionTimeText(seconds: number): string {
  return seconds < 0.05 ? 'Extracted in under 0.1 s' : `Extracted in ${seconds.toFixed(1)} s`;
}

/** The heading row of the review screen: title, unit line, extraction time and the buttons beside it. */
export function ReviewHeader({
  heading, meta, extractionSeconds, instrumentLine, onChangeInstrument, onBack, search, preview, originalScanUrl, pdfUrl, linksInMenu,
}: {
  heading: string;
  meta: ReactNode;
  extractionSeconds?: number | null;
  instrumentLine?: string;
  onChangeInstrument?: () => void;
  onBack?: () => void;
  search: ReturnType<typeof useReviewSearch>;
  preview: ReturnType<typeof useScanPreview>;
  originalScanUrl?: string;
  pdfUrl?: string;
  linksInMenu?: boolean;
}) {
  const { phone, phoneScan } = preview;
  return (
    <div className="section-title-row">
      <div>
        <div className="section-title report-heading">{heading}</div>
        {instrumentLine && (
          <div className="report-instrument-line" data-testid="review-instrument-line">
            <span>{instrumentLine}</span>
            {onChangeInstrument && (
              <button type="button" className="link-button" onClick={onChangeInstrument}>
                Change
              </button>
            )}
          </div>
        )}
        {(meta || extractionSeconds != null) && (
          <div className="report-heading-meta">
            {meta}
            {meta && extractionSeconds != null && ' · '}
            {extractionSeconds != null && <span data-testid="extraction-time">{extractionTimeText(extractionSeconds)}</span>}
          </div>
        )}
      </div>
      <div className="section-title-actions">
        {onBack && (
          <button
            type="button"
            className="btn small"
            data-testid="back-to-classify"
            title="Change the instrument or report type. Reading the document again replaces edits made here."
            onClick={onBack}
          >
            ← Back to Classify
          </button>
        )}
        {!(phone && phoneScan) && (
          <button
            type="button"
            className="btn small"
            data-testid="review-search-toggle"
            aria-label="Search values"
            aria-expanded={search.open}
            title="Search the values (Ctrl+F)"
            onClick={() => (search.open ? search.closeSearch() : search.openSearch())}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <ScanToggleButton preview={preview} />
        {originalScanUrl && !(phone && (linksInMenu || phoneScan)) && (
          <a className="btn small" href={originalScanUrl} target="_blank" rel="noreferrer">
            View original scan
          </a>
        )}
        {pdfUrl && !(phone && (linksInMenu || phoneScan)) && (
          <a className="btn small" href={pdfUrl}>
            Download PDF
          </a>
        )}
      </div>
    </div>
  );
}
