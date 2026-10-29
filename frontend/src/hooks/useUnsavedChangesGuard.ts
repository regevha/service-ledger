import { useEffect } from 'react';

/**
 * While `dirty` is true, reloading or closing the page asks the browser's own "leave site?" question.
 * Browsers show their fixed wording, not ours. Moving around inside the app is not covered here.
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}
