import { createContext, useContext } from 'react';
import type { OnboardingStatus } from './api';

/**
 * What a first-time visitor needs on every screen that can be empty: a way to
 * get a report in ("Upload your first report"), a way to see the app with data
 * in it ("Load demo data"), and, in the app shell, two notices (demo data is
 * on screen; the background worker is not running). The components that show
 * them are in components/FirstRun.tsx.
 *
 * The app shell owns the real state (the status poll, switching screens,
 * reloading what is on screen after the data changes) and hands it down
 * through this context, so an empty screen does not need three more props to
 * offer a button.
 */

export type AppView = 'new' | 'reports' | 'analytics' | 'templates' | 'instruments';

export interface FirstRun {
  /** From GET /onboarding/status; null until the first answer (or if there never is one). */
  status: OnboardingStatus | null;
  goTo: (view: AppView) => void;
  /** Load the demo reports and reload what is on screen. */
  loadDemo: () => Promise<void>;
  /** Remove the demo reports (and sample-report reports) and reload what is on screen. */
  removeDemo: () => Promise<void>;
}

const FirstRunContext = createContext<FirstRun>({
  status: null,
  goTo: () => undefined,
  loadDemo: async () => undefined,
  removeDemo: async () => undefined,
});

export const FirstRunProvider = FirstRunContext.Provider;

export function useFirstRun(): FirstRun {
  return useContext(FirstRunContext);
}

/** A job that has waited this long in the queue means nothing is taking jobs. */
export const WORKER_WAIT_SECONDS = 15;

/** Whether the queue's oldest waiting job has waited long enough to say the worker is not running. */
export function workerLooksDown(status: OnboardingStatus | null): boolean {
  return status !== null && status.oldest_pending_seconds !== null && status.oldest_pending_seconds >= WORKER_WAIT_SECONDS;
}
