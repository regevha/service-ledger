import { useState, type ReactNode } from 'react';
import { ScanPages } from './ScanPages';
import { useMediaQuery } from '../hooks/useMediaQuery';

const SCAN_PREF_KEY = 'sl.review.showScan';

// Per-viewer convenience only: browser storage can be empty or throw, so the page works without it.
function readScanPref(): boolean {
  try {
    return localStorage.getItem(SCAN_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}
function writeScanPref(on: boolean) {
  try {
    localStorage.setItem(SCAN_PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* not remembered; nothing else depends on it */
  }
}

/**
 * How the original document is shown next to a form: beside it on a wide
 * screen (with a Show/Hide button), and behind a Fields | Scan switch on a
 * phone or tablet. Shared by the "Classify" confirmation and the "Review & finalize"
 * screen, so both show the document the same way and remember the same
 * Show/Hide choice.
 */
export function useScanPreview(scanInlineUrl?: string, scanAttachmentId?: string) {
  const wide = useMediaQuery('(min-width: 900px)');
  const phone = useMediaQuery('(max-width: 620px)');
  // Below the side-by-side width (phones and tablets) the scan sits behind the Fields | Scan switch.
  const narrow = useMediaQuery('(max-width: 899px)');
  const [scanOpen, setScanOpen] = useState(readScanPref);
  const [phoneView, setPhoneView] = useState<'fields' | 'scan'>('fields');
  return {
    wide,
    phone,
    scanOpen,
    toggleScan: () => {
      setScanOpen(!scanOpen);
      writeScanPref(!scanOpen);
    },
    phoneView,
    setPhoneView,
    scanInlineUrl,
    scanAttachmentId,
    // Side by side with the form (wide screens only).
    showScan: Boolean(scanInlineUrl) && wide && scanOpen,
    // The page-image view, reached through the Fields | Scan switch, wherever the scan cannot sit beside the form.
    phoneScan: narrow && Boolean(scanAttachmentId),
  };
}

export type ScanPreviewState = ReturnType<typeof useScanPreview>;

/** "Hide scan" / "Show scan" — only offered where the scan can sit beside the form. */
export function ScanToggleButton({ preview }: { preview: ScanPreviewState }) {
  if (!preview.scanInlineUrl || !preview.wide) return null;
  return (
    <button type="button" className="btn small" onClick={preview.toggleScan}>
      {preview.scanOpen ? 'Hide scan' : 'Show scan'}
    </button>
  );
}

/** Below 900px (phone or tablet): the Fields | Scan switch, and the scan pages while "Scan" is chosen. */
export function PhoneScanSwitch({ preview }: { preview: ScanPreviewState }) {
  if (!preview.phoneScan || !preview.scanAttachmentId) return null;
  return (
    <>
      <div className="view-switch" role="tablist" aria-label="Show fields or scan">
        {(['fields', 'scan'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={preview.phoneView === v}
            className={`view-switch-button${preview.phoneView === v ? ' active' : ''}`}
            onClick={() => preview.setPhoneView(v)}
          >
            {v === 'fields' ? 'Fields' : 'Scan'}
          </button>
        ))}
      </div>
      {preview.phoneView === 'scan' && <ScanPages attachmentId={preview.scanAttachmentId} />}
    </>
  );
}

/** The form (children) with the scan beside it on a wide screen; hidden on a phone while its scan is showing. */
export function ScanSplit({ preview, children }: { preview: ScanPreviewState; children: ReactNode }) {
  return (
    <div
      className={`review-split${preview.showScan ? ' with-scan' : ''}`}
      hidden={preview.phoneScan && preview.phoneView === 'scan'}
    >
      {preview.showScan && (
        <aside className="review-scan" aria-label="Original scan">
          <iframe src={`${preview.scanInlineUrl}#view=FitH`} title="Original scan" />
        </aside>
      )}
      <div className="review-fields">{children}</div>
    </div>
  );
}
