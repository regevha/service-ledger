import type { EmailLogRow } from '../../api/emailIntake';
const OUTCOMES: Record<string, string> = {
  processed: 'Handled', unknown_sender: 'Dropped: sender not on the list',
  sender_not_verified: 'Dropped: sender could not be confirmed', rate_limited: 'Dropped: too many emails in an hour',
  no_pdf: 'No PDF attached', too_large: 'Email too large to open', auto_reply_ignored: 'Ignored: automatic reply', error: 'Could not be handled',
};
export const emailOutcome = (value: string) => OUTCOMES[value] ?? value;
export const replyStatus = (value: string) => ({ none: 'None', pending: 'Waiting to send', sent: 'Sent', failed: 'Not sent' })[value] ?? value;
export function emailFiles(row: Pick<EmailLogRow, 'file_count' | 'files_loaded' | 'files_held' | 'files_refused' | 'files_skipped'>) {
  if (!row.file_count) return 'No PDFs';
  const counts = [[row.files_loaded, 'loaded'], [row.files_held, 'held'], [row.files_refused, 'refused'], [row.files_skipped, 'skipped (over the per-email limit)']] as const;
  const outcomes = counts.filter(([count]) => count > 0).map(([count, word]) => row.file_count === 1 ? word : `${count} ${word}`);
  return `${row.file_count} PDF${row.file_count === 1 ? '' : 's'}${outcomes.length ? `: ${outcomes.join(', ')}` : ''}`;
}
