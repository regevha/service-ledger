import type { ReportStatus } from './api';

// The pure parts of the several-files screen: what a file's state is called, how a list of files is counted, and
// how many run at once. No network here, so specs can import it.

export type BatchState =
  | 'queued'
  | 'uploading'
  | 'language'
  | 'identifying'
  | 'reading'
  | 'ready'
  | 'approved'
  | 'duplicate'
  | 'attention'
  | 'failed';

export interface BatchItem {
  id: number;
  file: File;
  state: BatchState;
  /** Why the file stopped, for attention, failed and duplicate. */
  message?: string;
  reportId?: string;
  /** For a duplicate: the report that already holds this exact file. */
  existingReportId?: string;
  /** What was read from the file, once it is ready. */
  instrument?: string;
  reportType?: string;
}

export const WORKING_STATES: BatchState[] = ['uploading', 'language', 'identifying', 'reading'];

/** The state's words on screen. */
export const STATE_LABEL: Record<BatchState, string> = {
  queued: 'Waiting',
  uploading: 'Uploading',
  language: 'Checking language',
  identifying: 'Identifying',
  reading: 'Reading fields',
  ready: 'Ready to check',
  approved: 'Approved',
  duplicate: 'Already on file',
  attention: 'Needs you',
  failed: 'Failed',
};

/** Whether the file still needs the person: nothing left to wait for and not yet approved. */
export function needsPerson(item: BatchItem): boolean {
  return item.state === 'ready' || item.state === 'attention' || item.state === 'failed';
}

export function summarize(items: BatchItem[]): { total: number; ready: number; approved: number; working: number; stopped: number } {
  return {
    total: items.length,
    ready: items.filter((i) => i.state === 'ready').length,
    approved: items.filter((i) => i.state === 'approved').length,
    working: items.filter((i) => i.state === 'queued' || WORKING_STATES.includes(i.state)).length,
    stopped: items.filter((i) => i.state === 'attention' || i.state === 'failed' || i.state === 'duplicate').length,
  };
}

/** The state a stored report's status means for a file that was read: finalized is approved, anything else still waits. */
export function stateForReportStatus(status: ReportStatus): BatchState {
  return status === 'finalized' ? 'approved' : 'ready';
}

/** Runs `worker` over `items` with at most `limit` running at once, in order. */
export async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

