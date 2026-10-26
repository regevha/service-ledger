import { useEffect, useState } from 'react';
import { subscribeToast, type ToastMessage } from '../toast';

const SHOW_MS = 3000;

/** Shows the latest toast for a few seconds. Screen readers hear it through the live region. */
export function ToastHost() {
  const [message, setMessage] = useState<ToastMessage | null>(null);

  useEffect(() => subscribeToast(setMessage), []);
  useEffect(() => {
    if (!message) return;
    const handle = setTimeout(() => setMessage(null), SHOW_MS);
    return () => clearTimeout(handle);
  }, [message]);

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {message && (
        <div className="toast" key={message.id}>
          {message.text}
        </div>
      )}
    </div>
  );
}
