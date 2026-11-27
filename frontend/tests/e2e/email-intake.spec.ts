import type { Page, Route } from '@playwright/test';
import type { AllowedSender, EmailLogRow, HeldFile } from '../../src/api/emailIntake';
import type { Report, ReportSource } from '../../src/api/types';
import { test, expect } from './coverage';
import { API_BASE, listReportIds, okJson, seedReport } from './helpers/api';

const receivedAt = '2026-11-02T10:00:00Z';
const mailbox = {
  enabled: true,
  mailbox: 'folder',
  sender: 'folder',
  intake_address: 'reports@example.org',
  max_pdfs_per_message: 10,
  max_pdf_megabytes: 20,
  poll_interval_seconds: 60,
};

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

function emailRoute(page: Page, path: RegExp, handler: (route: Route) => Promise<void>) {
  return page.route(path, (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: corsHeaders })
    : handler(route));
}

function json(route: Route, data: unknown, status = 200) {
  return route.fulfill({ json: data, status, headers: corsHeaders });
}

async function mockMailbox(page: Page, enabled = true) {
  await emailRoute(page, /\/email-intake\/status$/, (route) => json(route, { ...mailbox, enabled }));
  await emailRoute(page, /\/email-intake\/held$/, (route) => json(route, []));
}

test('disabled email intake shows its status', async ({ page }) => {
  await mockMailbox(page, false);

  await page.goto('/#/admin/email');
  await expect(page.getByText('Email intake is off.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a sender' })).toHaveCount(0);
});

test('admin can retry loading senders and add, rename, and remove an address', async ({ page }) => {
  await mockMailbox(page);
  let sender: AllowedSender | undefined;
  let sendersAvailable = false;
  await emailRoute(page, /\/email-intake\/allowed-senders(?:\/address-1)?$/, async (route) => {
    switch (route.request().method()) {
      case 'POST': {
        const data = route.request().postDataJSON();
        expect(data).toEqual({ kind: 'address', value: 'lab@example.org', label: 'Lab team' });
        sender = { ...data, id: 'address-1', created_at: receivedAt };
        return json(route, sender, 201);
      }
      case 'PATCH': {
        const data = route.request().postDataJSON();
        expect(data).toEqual({ label: 'Field team' });
        sender = { ...sender!, label: data.label };
        return json(route, sender);
      }
      case 'DELETE':
        sender = undefined;
        return route.fulfill({ status: 204, headers: corsHeaders });
      default:
        if (!sendersAvailable) {
          return json(route, { detail: 'Unavailable' }, 503);
        }
        return json(route, sender ? [sender] : []);
    }
  });

  await page.goto('/#/admin/email');
  await expect(page.getByText('reports@example.org', { exact: true })).toBeVisible();
  await expect(page.getByText('This is the test mailbox:', { exact: false })).toBeVisible();
  const loadError = page.getByRole('alert').filter({ hasText: 'Could not load the allowed senders' });
  await expect(loadError).toBeVisible();
  sendersAvailable = true;
  await loadError.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('button', { name: 'Add a sender' }).click();
  const address = page.getByRole('textbox', { name: 'Email address' });
  const role = page.getByRole('textbox', { name: 'Team or role' });
  await page.getByRole('button', { name: 'Add sender' }).click();
  await expect(address).toHaveAttribute('aria-invalid', 'true');
  await expect(role).toHaveAttribute('aria-invalid', 'true');
  await address.fill('LAB@EXAMPLE.ORG');
  await role.fill('Lab team');
  await page.getByRole('button', { name: 'Add sender' }).click();

  const row = page.getByRole('row').filter({ hasText: 'lab@example.org' });
  await expect(row).toContainText('Lab team');
  await row.getByRole('button', { name: 'Change team or role for lab@example.org' }).click();
  await role.fill('Field team');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row).toContainText('Field team');

  await row.getByRole('button', { name: 'Remove lab@example.org' }).click();
  await page.getByRole('alertdialog', { name: 'Confirm remove sender' }).getByRole('button', { name: 'Confirm remove' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText('No allowed senders yet.', { exact: false })).toBeVisible();
});

test('admin can release or delete a held file and browse the email log', async ({ page }) => {
  await mockMailbox(page);
  let held: HeldFile[] = [
    { id: 'held-1', received_at: receivedAt, sender_label: 'Field team', reason: 'Unknown form', page_count: 1, size_bytes: 1024 },
    { id: 'held-2', received_at: receivedAt, sender_label: null, reason: 'Low confidence', page_count: null, size_bytes: 2097152 },
  ];
  await emailRoute(page, /\/email-intake\/held(?:\/held-[12](?:\/release)?)?$/, (route) => {
    const method = route.request().method();
    switch (method) {
      case 'POST':
        expect(new URL(route.request().url()).pathname).toBe('/email-intake/held/held-1/release');
        held = held.filter(({ id }) => id !== 'held-1');
        return json(route, { report_id: 'draft-1', read_state: 'needs_person' });
      case 'DELETE':
        expect(new URL(route.request().url()).pathname).toBe('/email-intake/held/held-2');
        held = held.filter(({ id }) => id !== 'held-2');
        return route.fulfill({ status: 204, headers: corsHeaders });
      default:
        return json(route, held);
    }
  });
  const recent: EmailLogRow = {
    id: 'email-1', received_at: receivedAt, sender_label: 'Field team', sender_address: 'lab@example.org',
    outcome: 'processed', reason: null, file_count: 2, files_loaded: 1, files_held: 1, files_refused: 0,
    files_skipped: 0, reply_status: 'sent',
  };
  await emailRoute(page, /\/email-intake\/log\?/, (route) => {
    const older = new URL(route.request().url()).searchParams.get('offset') === '50';
    const entry = older
      ? { ...recent, id: 'email-2', sender_label: null, sender_address: null, outcome: 'sender_not_verified',
          file_count: 0, files_loaded: 0, files_held: 0, reply_status: 'failed' }
      : recent;
    return json(route, { total: 51, items: [entry] });
  });

  await page.goto('/#/admin/email');
  await page.getByRole('link', { name: 'Held for a check (2)' }).click();
  const firstRow = page.getByRole('row').filter({ hasText: 'Unknown form' });
  await expect(firstRow).toContainText('1 page · 1 KB');
  await firstRow.getByRole('button', { name: 'Load as draft' }).click();
  await expect(page.getByRole('link', { name: 'Open the draft' })).toHaveAttribute('href', '#/reports/draft-1');
  await expect(page.getByRole('link', { name: 'Held for a check (1)' })).toBeVisible();

  const secondRow = page.getByRole('row').filter({ hasText: 'Low confidence' });
  await expect(secondRow).toContainText('2.0 MB');
  await secondRow.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog', { name: 'Confirm delete held file' }).getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.getByText('Nothing to check.', { exact: false })).toBeVisible();

  await page.getByRole('link', { name: 'Email log', exact: true }).click();
  const log = page.getByRole('region', { name: 'Email log' });
  await expect(log).toContainText('2 PDFs: 1 loaded, 1 held');
  await expect(log.getByRole('cell', { name: 'Sent', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Older' }).click();
  await expect(log).toContainText('Dropped: sender could not be confirmed');
  await expect(log).toContainText('Tried 3 times');
  await expect(page.getByRole('button', { name: 'Older' })).toBeDisabled();
  await page.getByRole('button', { name: 'Newer' }).click();
  await expect(log).toContainText('Handled');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(log).toContainText('Handled');
});

test('email draft waits for reading and continues the same report when it needs a report type', async ({ page, request }) => {
  const { reportId, attachmentId } = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', extract: false });
  const report = await okJson<Report>(await request.get(API_BASE + '/reports/' + reportId), 'read draft');
  let source: ReportSource = {
    channel: 'email', received_at: receivedAt, sender_label: 'Field team', sender_address: 'lab@example.org',
    read_state: 'waiting_for_limit', needs_report_type: false,
  };
  await emailRoute(page, new RegExp('/reports/' + reportId + '$'), (route) =>
    json(route, { ...report, status: 'draft', instrument_id: null, template_id: null, source }));
  await emailRoute(page, new RegExp('/reports/' + reportId + '/intake-state$'), (route) =>
    json(route, {
      report_id: reportId, status: 'draft', attachment_id: attachmentId,
      translation_status: null, translation_required: false,
      latest_jobs: { translate: null, classify: null, extract: null }, source,
    }));

  const ids = await listReportIds(request);
  await page.goto('/#/reports/' + reportId);
  await expect(page.getByText('Received by email · Field team', { exact: false })).toBeVisible();
  await expect(page.getByText('Waiting for the daily limit.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);

  source = { ...source, read_state: 'queued' };
  await page.reload();
  await expect(page.getByText('Being read now.', { exact: true })).toBeVisible();
  source = { ...source, read_state: 'needs_person', needs_report_type: true };
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByText('Needs a report type.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('#/new/' + reportId + '$'));
  await expect(page.getByText('The app did not recognise this kind of report.', { exact: false })).toBeVisible();
  expect(await listReportIds(request)).toEqual(ids);
});
