import { plainMessage } from '../plainMessages';

/**
 * The warning shown when a screen could not load its data: the failure in plain words (never the server
 * command or setting names the raw message carries) and, when the screen can load again, a Try again button.
 */
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner banner-warn banner-with-action" role="alert">
      <span>{plainMessage(message)}</span>
      {onRetry && (
        <button type="button" className="btn small" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
