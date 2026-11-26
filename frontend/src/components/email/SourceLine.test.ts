import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Report } from '../../api/types';
import { SourceLine } from './SourceLine';
import { ReportRow } from '../reports/ReportRow';
const report = { created_at: '2026-11-01T12:00:00Z', source: null } as Report;
describe('report provenance', () => {
  it('shows the web source and semantic time', () => {
    const html = renderToStaticMarkup(createElement(SourceLine, { report }));
    expect(html).toContain('Uploaded in the app'); expect(html).toContain('dateTime="2026-11-01T12:00:00Z"');
  });
  it('shows the recorded email label and address', () => {
    const html = renderToStaticMarkup(createElement(SourceLine, { report: { ...report, source: { channel: 'email', sender_address: 'lab@example.org', sender_label: 'Original lab team', received_at: report.created_at, read_state: null, needs_report_type: false } } }));
    expect(html).toContain('Received by email'); expect(html).toContain('Original lab team'); expect(html).toContain('Sent from lab@example.org');
  });
  it('shows the email marker on an unread row without showing provenance addresses', () => {
    const html = renderToStaticMarkup(createElement(ReportRow, { r: { id: 'report', status: 'draft', source_channel: 'email', instrument_model: null, instrument_serial_number: null, report_type: null, technician_name: null, report_date: null, created_at: report.created_at, finalized_at: null }, onOpen: () => {} }));
    expect(html).toContain('By email'); expect(html).toContain('Received by email'); expect(html).toContain('received'); expect(html).not.toContain('lab@example.org');
  });
});
