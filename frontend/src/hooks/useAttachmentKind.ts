import { useEffect, useState } from 'react';
import { getAttachmentPageCount } from '../api';

/** 'text' for an HTML report (no page images, so no fields drawn on the page), 'pages' otherwise; null until known. */
export function useAttachmentKind(attachmentId: string | undefined): 'pages' | 'text' | null {
  const [kind, setKind] = useState<'pages' | 'text' | null>(null);
  useEffect(() => {
    let live = true;
    if (attachmentId) {
      getAttachmentPageCount(attachmentId)
        .then((r) => live && setKind(r.kind === 'text' ? 'text' : 'pages'))
        .catch(() => live && setKind('pages')); // unknown (the scan could not be read): keep the page view, as before
    }
    return () => {
      live = false;
    };
  }, [attachmentId]);
  return kind;
}
