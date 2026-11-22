import { useEffect, useState } from 'react';
import { getAttachmentPageCount } from '../api';

/** 'text' for an HTML report (no page images, so no fields drawn on the page), otherwise 'pages'. */
export function useAttachmentKind(attachmentId: string | undefined): 'pages' | 'text' {
  const [kind, setKind] = useState<'pages' | 'text'>('pages');
  useEffect(() => {
    let live = true;
    if (attachmentId) {
      getAttachmentPageCount(attachmentId)
        .then((r) => live && setKind(r.kind === 'text' ? 'text' : 'pages'))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [attachmentId]);
  return kind;
}
