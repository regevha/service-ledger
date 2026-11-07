import { useEffect, useState } from 'react';
import { getAttachmentPageCount, getFieldLocations, type FieldLocations } from '../api';

/** The field locations of a document, and how many pages it has (read separately when the locations cannot be). */
export function useFieldLocations(attachmentId: string | undefined) {
  const [state, setState] = useState<{ id: string; locations: FieldLocations | null; pages: number } | null>(null);
  useEffect(() => {
    if (!attachmentId) return;
    let live = true;
    getFieldLocations(attachmentId)
      .then((locations) => live && setState({ id: attachmentId, locations, pages: locations.page_count }))
      .catch(() =>
        getAttachmentPageCount(attachmentId)
          .then((r) => live && setState({ id: attachmentId, locations: null, pages: r.page_count }))
          .catch(() => live && setState({ id: attachmentId, locations: null, pages: 1 })),
      );
    return () => {
      live = false;
    };
  }, [attachmentId]);
  const current = state && state.id === attachmentId ? state : null;
  return { locations: current?.locations ?? null, pages: current?.pages ?? 0, loading: Boolean(attachmentId) && current === null };
}
