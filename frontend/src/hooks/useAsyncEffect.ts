import { useEffect, useState, type DependencyList } from 'react';
import { ApiError } from '../api';

/**
 * The loading/error/cancellation bookkeeping every data-fetching screen in
 * this app was hand-rolling on its own — AnalyticsScreen, both of
 * InstrumentTrendSection's effects, ReportsListScreen, ReportDetailScreen,
 * and InstrumentDetailScreen each wrote their own copy of: a `cancelled`
 * flag closed over by the effect's cleanup, `setLoading(true)`/
 * `setError(null)` before the fetch, an ApiError-aware `.catch`, and a
 * `.finally(() => setLoading(false))` — six near-identical copies, differing
 * only in what they actually fetched and where the result went.
 *
 * `effect` does the fetching and applies its own result(s) to whatever
 * state the caller owns — a screen may set more than one piece of state
 * from a single load (e.g. ReportDetailScreen setting both the report and
 * its resolved template). It's handed an `isCancelled()` check so it can
 * guard those updates against a stale response landing after a newer run
 * started or the component unmounted — exactly the `if (!cancelled)` guards
 * this replaces, just pushed into the caller's own effect body instead of
 * duplicated around every `.then`. `setError` is returned too, so a call
 * site that also needs to report a *later*, non-effect failure into the
 * same banner (e.g. a save action that runs after the initial load) can
 * reuse this one error state instead of keeping a second one just for that.
 */
export function useAsyncEffect(
  effect: (isCancelled: () => boolean) => Promise<void>,
  deps: DependencyList,
  fallbackMessage: string
): { loading: boolean; error: string | null; setError: (message: string | null) => void } {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    effect(() => cancelled)
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : fallbackMessage);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `deps` is the caller's own explicit dependency list, mirroring a plain
    // useEffect's second argument — intentionally not "everything this
    // closure references" (which would include `effect` itself, a new
    // function identity on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { loading, error, setError };
}
