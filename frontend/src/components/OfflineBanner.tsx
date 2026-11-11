import { useOnline } from '../hooks/useOnline';

/** Shown on every screen while the browser has no connection, so a save or an upload that does nothing is not a mystery. */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="banner banner-warn offline-banner" role="status" data-testid="offline-banner">
      You are offline. Saving and uploading will not work until the connection is back; what is on this page stays as it is.
    </div>
  );
}
