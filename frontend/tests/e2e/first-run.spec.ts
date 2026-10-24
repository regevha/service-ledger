import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import { textPdf } from './text-pdf';
import { BACKEND_PORT } from '../../playwright.config';

// What a first-time visitor sees: a sample report to try, demo data to look at,
// screens that say what to do when they are empty, a progress list while a scan
// is read, a shorter review, and a notice when the background worker is not
// running. The shared e2e database is never empty, so the empty screens are
// reached by answering the one list request with nothing.

const API_BASE = `http://localhost:${BACKEND_PORT}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');
const SAMPLE_WORK_ORDER = path.join(__dirname, 'fixtures', 'sample-work-order.pdf');

type Page = import('@playwright/test').Page;
type Request = import('@playwright/test').APIRequestContext;

const NO_ANALYTICS = {
  finalized_report_count: 0,
  parts_replaced: [],
  total_labor_hours: 0,
  labor_hours_by_instrument: [],
  labor_hours_by_fault_category: {},
  pass_fail_by_report_type: {},
};

const IDLE_STATUS = {
  instruments: 5,
  reports: 3,
  finalized_reports: 3,
  demo_reports: 0,
  pending_jobs: 0,
  oldest_pending_seconds: null,
};

// Demo data loaded by a test must not stay behind for the specs that count reports.
test.afterEach(async ({ request }) => {
  await request.delete(`${API_BASE}/onboarding/demo-data`);
});

async function hasDemoBanner(page: Page) {
  await expect(page.locator('#demo-banner')).toContainText('demo data');
}

test.describe('try a sample report', () => {
  test('runs the whole flow from one click, shows what was found, and can be removed again', async ({ page }) => {
    await page.goto('/');
    await page.click('.view-tab:has-text("New report")');
    await expect(page.getByTestId('sample-offer')).toContainText('No scan handy?');

    // Slow the reading down so the progress list can be seen while it runs.
    await page.route(/\/attachments\/[^/]+\/extract$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.click('button:has-text("Try a sample report")');

    const progress = page.getByTestId('working-progress');
    await expect(progress).toContainText('Uploaded sample-service-report.pdf', { timeout: 30_000 });
    await expect(progress).toContainText('Read LSRFortessa');
    await expect(progress).toContainText('serial R647794E6092');
    await expect(progress).toContainText('Malfunction / repair');
    await expect(progress).toContainText('Matched to LSRFortessa (R647794E6092)');

    await expect(page.locator('.field-list')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#sample-notice')).toContainText('made-up data');

    await page.click('button:has-text("Save & finalize report")');
    await expect(page.locator('.success-panel')).toBeVisible({ timeout: 15_000 });

    // What finalizing unlocked.
    const next = page.getByTestId('whats-next');
    await expect(next).toContainText('What you can do now');
    await expect(next.locator('#whats-next-history')).toContainText('LSRFortessa (R647794E6092) now has');
    await expect(next.locator('a[href*="/reports/export"]')).toBeVisible();
    await next.locator('button:has-text("See analytics")').click();
    await expect(page.locator('.view-tab.active')).toHaveText('Analytics');

    // It is demo data: said so, and removable.
    await hasDemoBanner(page);
    await page.click('#demo-banner button:has-text("Remove demo data")');
    await expect(page.locator('#demo-banner')).toHaveCount(0);
  });

  test('each sample is a new document, so it can be tried again', async ({ page }) => {
    for (let i = 0; i < 2; i++) {
      await page.goto('/');
      await page.click('.view-tab:has-text("New report")');
      await page.click('button:has-text("Try a sample report")');
      await expect(page.locator('.field-list')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('#already-on-file-notice')).toHaveCount(0);
    }
  });

  test('the Lab manager name is remembered between reports', async ({ page }) => {
    await page.goto('/');
    await page.click('.view-tab:has-text("New report")');
    await page.fill('input[placeholder="Your name (optional)"]', 'E2E Remembered');
    await page.locator('input[type="file"]').setInputFiles(uniqueFixture(FIXTURE));
    await page.click('button:has-text("Upload & classify")');
    await expect(page.locator('.field-list')).toBeVisible({ timeout: 30_000 });
    await page.click('button:has-text("Save & finalize report")');
    await expect(page.locator('.success-panel')).toBeVisible({ timeout: 15_000 });

    await page.click('button:has-text("Start another report")');
    await expect(page.locator('input[placeholder="Your name (optional)"]')).toHaveValue('E2E Remembered');
    // The upload box comes first, the name after it.
    const [dropzone, name] = await Promise.all([
      page.locator('.dropzone').boundingBox(),
      page.locator('input[placeholder="Your name (optional)"]').boundingBox(),
    ]);
    expect(dropzone!.y).toBeLessThan(name!.y);

    await page.reload();
    await page.click('.view-tab:has-text("New report")');
    await expect(page.locator('input[placeholder="Your name (optional)"]')).toHaveValue('E2E Remembered');
  });
});

test.describe('empty screens say what to do', () => {
  test('no reports: upload one, or load demo data and see it filled in', async ({ page }) => {
    // The list is empty until the demo data is loaded; then the real list comes back.
    let loaded = false;
    await page.route(`${API_BASE}/reports`, (route) => (loaded ? route.continue() : route.fulfill({ json: [] })));
    await page.route(`${API_BASE}/onboarding/demo-data`, async (route) => {
      if (route.request().method() === 'POST') loaded = true;
      await route.continue();
    });
    await page.goto('/#/reports');
    const empty = page.getByTestId('empty-state');
    await expect(empty).toContainText('No reports yet');

    await empty.locator('button:has-text("Load demo data")').click();
    await expect(page.locator('.report-table')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.report-row-body:has-text("Demo - FACSAria III repair")')).toBeVisible();
    await hasDemoBanner(page);

    await page.click('#demo-banner button:has-text("Remove demo data")');
    await expect(page.locator('#demo-banner')).toHaveCount(0);
    await expect(page.locator('.report-row-body:has-text("Demo - FACSAria III repair")')).toHaveCount(0);
  });

  test('no reports: the first button goes to the upload screen', async ({ page }) => {
    await page.route(`${API_BASE}/reports`, (route) => route.fulfill({ json: [] }));
    await page.goto('/#/reports');
    await page.getByTestId('empty-state').locator('button:has-text("Upload your first report")').click();
    await expect(page.locator('.view-tab.active')).toHaveText('New report');
    await expect(page.locator('.dropzone')).toBeVisible();
  });

  test('analytics with nothing finalized explains itself instead of showing empty charts', async ({ page }) => {
    await page.route(/\/analytics\/fleet/, (route) => route.fulfill({ json: NO_ANALYTICS }));
    await page.goto('/#/analytics');
    await expect(page.getByTestId('empty-state')).toContainText('Nothing to chart yet');
    await expect(page.locator('.stat-row')).toHaveCount(0);
  });

  test('no instruments: says how to add one, with no demo button (nothing to attach it to)', async ({ page }) => {
    await page.route(`${API_BASE}/instruments`, (route) => route.fulfill({ json: [] }));
    await page.route(`${API_BASE}/onboarding/status`, (route) => route.fulfill({ json: { ...IDLE_STATUS, instruments: 0 } }));
    await page.goto('/#/instruments');
    const empty = page.getByTestId('empty-state');
    await expect(empty).toContainText('No instruments yet');
    await expect(empty).toContainText('+ New instrument');
    await expect(empty.locator('button')).toHaveCount(0);
  });

  test('a failed first classification with no instruments offers the way out', async ({ page }) => {
    const jobId = '00000000-0000-0000-0000-000000000001';
    const job = {
      id: jobId,
      attachment_id: '00000000-0000-0000-0000-000000000002',
      kind: 'classify',
      classification: null,
      field_confidences: null,
      started_at: null,
      completed_at: null,
    };
    await page.route(/\/attachments\/[^/]+\/classify$/, (route) =>
      route.fulfill({ status: 202, json: { ...job, status: 'pending', error_message: null } })
    );
    await page.route(new RegExp(`/extraction-jobs/${jobId}$`), (route) =>
      route.fulfill({
        json: { ...job, status: 'failed', error_message: 'No instruments registered — add one on the Instruments tab, then try again.' },
      })
    );
    await page.goto('/');
    await page.click('.view-tab:has-text("New report")');
    await page.locator('input[type="file"]').setInputFiles(uniqueFixture(FIXTURE));
    await page.click('button:has-text("Upload & classify")');
    await expect(page.locator('.banner-crit')).toContainText('No instruments registered', { timeout: 30_000 });
    await page.click('#create-template-action:has-text("Add an instrument")');
    await expect(page.locator('.view-tab.active')).toHaveText('Instruments');
  });
});

test.describe('setup is set apart', () => {
  test('Templates and Instruments sit under their own Setup label and still work', async ({ page }) => {
    await page.goto('/');
    const setup = page.getByRole('group', { name: 'Setup' });
    await expect(setup.locator('.view-tab')).toHaveText(['Templates', 'Instruments']);
    await expect(page.locator('.view-tabs > .view-tab')).toHaveText(['New report', 'Reports', 'Analytics']);

    await setup.locator('.view-tab:has-text("Instruments")').click();
    await expect(page.locator('.view-tab.active')).toHaveText('Instruments');
  });
});

test.describe('the background worker', () => {
  test('a job that waits too long says the worker is not running, and clears when it is', async ({ page }) => {
    let waiting = true;
    await page.route(`${API_BASE}/onboarding/status`, (route) =>
      route.fulfill({
        json: waiting ? { ...IDLE_STATUS, pending_jobs: 2, oldest_pending_seconds: 40 } : IDLE_STATUS,
      })
    );
    await page.goto('/');
    const banner = page.locator('#worker-banner');
    await expect(banner).toContainText('python -m app.worker');
    await expect(banner).toContainText('docker compose up');

    waiting = false;
    await page.click('.view-tab:has-text("Reports")'); // moving between screens asks again
    await expect(banner).toHaveCount(0);
  });

  test('a short wait is not an alarm', async ({ page }) => {
    await page.route(`${API_BASE}/onboarding/status`, (route) =>
      route.fulfill({ json: { ...IDLE_STATUS, pending_jobs: 1, oldest_pending_seconds: 3 } })
    );
    await page.goto('/');
    await page.click('.view-tab:has-text("Reports")');
    await expect(page.locator('#worker-banner')).toHaveCount(0);
  });
});

test.describe('a shorter review', () => {
  async function toReview(page: Page) {
    await page.goto('/');
    await page.click('.view-tab:has-text("New report")');
    await page.locator('input[type="file"]').setInputFiles(uniqueFixture(SAMPLE_WORK_ORDER));
    await page.click('button:has-text("Upload & classify")');
    await page.waitForSelector('.class-row', { timeout: 30_000 });
    await page.click('button:has-text("Confirm & continue")');
    await expect(page.locator('.field-list')).toBeVisible({ timeout: 30_000 });
  }

  test('show only the fields that need a look, check them off, then accept the rest', async ({ page }) => {
    await toReview(page);
    const pending = page.locator('.field-list .field.pending');
    const total = await page.locator('.field-list .field').count();
    const flagged = await pending.count();
    expect(flagged).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(flagged);

    await page.click('.review-actions button:has-text("Show only these")');
    await expect(page.locator('.field-list .field')).toHaveCount(flagged);
    await expect(page.getByTestId('focus-summary')).toContainText(`${total - flagged} other field`);
    // Not finished: the normal button is still the normal button.
    await expect(page.locator('button:has-text("Save & finalize report")')).toBeVisible();

    // Fixing one field and saying another is right both take them off the list.
    await page.locator('.field.pending', { hasText: 'root cause' }).locator('textarea').fill('Sample injector O-ring degraded');
    await expect(page.locator('.field-list .field.pending')).toHaveCount(flagged - 1);
    while ((await page.locator('.field-list .field.pending').count()) > 0) {
      await page.locator('.field-list .field.pending button:has-text("Looks right")').first().click();
    }
    await expect(page.locator('.review-actions')).toContainText('All flagged fields checked');
    await expect(page.locator('.field-list .field')).toHaveCount(0);

    await page.click('button:has-text("Accept the rest & finalize report")');
    await expect(page.locator('.success-panel')).toBeVisible({ timeout: 15_000 });
  });

  test('every field is still there until asked, and comes back with Show all fields', async ({ page }) => {
    await toReview(page);
    const total = await page.locator('.field-list .field').count();

    await page.click('.review-actions button:has-text("Show only these")');
    await expect(page.locator('.field-list .field')).not.toHaveCount(total);
    await page.getByTestId('focus-summary').locator('button:has-text("Show all fields")').click();
    await expect(page.locator('.field-list .field')).toHaveCount(total);
    await expect(page.getByTestId('focus-summary')).toHaveCount(0);
  });
});

test.describe('an unknown serial number is added on the spot', () => {
  test('the confirm screen offers the unit with its details filled in from the same model', async ({ page, request }: { page: Page; request: Request }) => {
    const serial = `R647794E6${String(Date.now()).slice(-3)}`;
    const marker = Date.now();
    // A BD form for an LSRFortessa whose serial is not in the fleet, with no task code (so the type is a manual pick).
    const pdf = textPdf([
      `WORK ORDER NUMBER: WO-8${String(marker).slice(-7)}`,
      'Installed Product',
      '647794E6 - LSRFortessa SO',
      'Serial Number',
      serial,
      'Visit notes',
      `E2E ${marker}`,
    ]);
    let createdId: string | undefined;
    try {
      await page.goto('/');
      await page.click('.view-tab:has-text("New report")');
      await page.locator('input[type="file"]').setInputFiles({ name: `fortessa-${marker}.pdf`, mimeType: 'application/pdf', buffer: pdf });
      await page.click('button:has-text("Upload & classify")');
      await page.waitForSelector('.class-row', { timeout: 30_000 });

      const panel = page.locator('#add-instrument-panel');
      await expect(panel).toContainText('This serial number is not in your fleet yet');
      await expect(panel.locator('input[aria-label="Instrument model"]')).toHaveValue('LSRFortessa');
      await expect(panel.locator('input[aria-label="Instrument manufacturer"]')).toHaveValue('BD');
      await expect(panel.locator('input[aria-label="Instrument serial number"]')).toHaveValue(serial);

      await panel.locator('input[aria-label="Instrument name"]').fill(`E2E-Fortessa-${marker}`);
      await panel.locator('button:has-text("Add instrument")').click();

      // Classified again, now matched to the new unit.
      await expect(page.locator('#serial-notice')).toContainText(`(${serial})`, { timeout: 30_000 });
      await expect(page.locator('#add-instrument-panel')).toHaveCount(0);
    } finally {
      const list = await (await request.get(`${API_BASE}/instruments`)).json();
      createdId = list.find((i: { serial_number: string }) => i.serial_number === serial)?.id;
      if (createdId) await request.delete(`${API_BASE}/instruments/${createdId}`);
    }
  });
});
