import { API_BASE, apiFetch } from './http';
import type { components } from '../generated/api-schema';
import type { ExtractionJob, ReportSource, ReportStatus } from './types';

export interface EmailIntakeStatus {
  enabled: boolean;
  mailbox: 'folder' | 'imap';
  sender: 'folder' | 'smtp';
  intake_address: string | null;
  max_pdfs_per_message: number;
  max_pdf_megabytes: number;
  poll_interval_seconds: number;
}
export interface AllowedSender {
  id: string;
  kind: 'address' | 'domain';
  value: string;
  label: string;
  created_at: string;
}
export interface HeldFile {
  id: string;
  received_at: string;
  sender_label: string | null;
  reason: string;
  page_count: number | null;
  size_bytes: number;
}
export interface EmailLogRow {
  id: string;
  received_at: string;
  outcome: string;
  reason: string | null;
  file_count: number;
  files_loaded: number;
  files_held: number;
  files_refused: number;
  files_skipped: number;
  sender_address: string | null;
  sender_label: string | null;
  reply_status: string;
}
export interface IntakeState {
  report_id: string;
  status: ReportStatus;
  attachment_id: string | null;
  translation_status: string | null;
  translation_required: boolean;
  latest_jobs: Record<'translate' | 'classify' | 'extract', ExtractionJob | null>;
  source: ReportSource | null;
}
const base = '/email-intake';
export const getEmailIntakeStatus = () => apiFetch<EmailIntakeStatus>(`${base}/status`);
export const pollEmailIntake = () => apiFetch<components['schemas']['EmailPollResult']>(`${base}/poll`, { method: 'POST' });
export const listAllowedSenders = () => apiFetch<AllowedSender[]>(`${base}/allowed-senders`);
export const addAllowedSender = (body: Pick<AllowedSender, 'kind' | 'value' | 'label'>) =>
  apiFetch<AllowedSender>(`${base}/allowed-senders`, { method: 'POST', body: JSON.stringify(body) });
export const changeAllowedSender = (id: string, label: string) =>
  apiFetch<AllowedSender>(`${base}/allowed-senders/${id}`, { method: 'PATCH', body: JSON.stringify({ label }) });
export const removeAllowedSender = (id: string) => apiFetch<void>(`${base}/allowed-senders/${id}`, { method: 'DELETE' });
export const listHeldFiles = () => apiFetch<HeldFile[]>(`${base}/held`);
export const heldFileUrl = (id: string) => `${API_BASE}${base}/held/${id}/file`;
export const releaseHeldFile = (id: string) => apiFetch<{ report_id: string; read_state: string }>(`${base}/held/${id}/release`, { method: 'POST' });
export const deleteHeldFile = (id: string) => apiFetch<void>(`${base}/held/${id}`, { method: 'DELETE' });
export const getEmailLog = (offset: number) => apiFetch<{ items: EmailLogRow[]; total: number }>(`${base}/log?limit=50&offset=${offset}`);
export const getIntakeState = (id: string) => apiFetch<IntakeState>(`/reports/${id}/intake-state`);
