import AxeBuilder from '@axe-core/playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import { TIMEOUT } from './timeouts';

// The prompt-before-send screen (VIEW_PROMPTS, a debug aid): when the backend parks a job as
// "awaiting_approval", the intake screen shows the exact request about to go to Claude and waits for
// Send or Cancel. The backend half is covered by pytest (test_prompt_preview.py). The stub-mode backend
// the e2e suite runs against never parks a job, because it never calls Claude, so here the first poll of
// a job is answered as "awaiting approval" with a fixed prompt, and the answers to Send and Cancel are
// played back instead of reaching the real job (which is not really parked). What is checked is the
// screen and its contract with the API: what it shows, which call each button makes, and that nothing
// else is sent in between.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'synthetic-confident-scan.pdf');

const PREVIEW = {
  verb: 'classify',
  model: 'claude-test-model',
  max_tokens: 1234,
  system: { note: 'system-prompt-marker' },
  tool_choice: { type: 'tool', name: 'record_classification' },
  tools: [{ name: 'record_classification', description: 'tool-definition-marker' }],
  blocks: [
    { type: 'text', role: 'user', text: 'first-text-block-marker' },
    { type: 'document', role: 'user', media_type: 'application/pdf', bytes: 4321, sha256: 'ab'.repeat(32) },
    { type: 'text', role: 'user', text: 'second-text-block-marker' },
  ],
};

/**
 * Answers the first poll of the first job as "awaiting approval" and records the calls the screen
 * makes in answer. Send and Cancel are fulfilled here: the real job was never parked, so the real
 * endpoints would refuse them.
 */
async function parkFirstJob(page: Page) {
  const calls: string[] = [];
  let parkedJobId: string | null = null;
  await page.route('**/extraction-jobs/*', async (route: Route) => {
    const request = route.request();
    const jobId = new URL(request.url()).pathname.split('/')[2];
    if (request.method() === 'GET') {
      if (parkedJobId !== null) return route.continue();
      parkedJobId = jobId;
      const real = await (await route.fetch()).json();
      return route.fulfill({ json: { ...real, status: 'awaiting_approval', prompt_preview: PREVIEW } });
    }
    return route.continue();
  });
  await page.route('**/extraction-jobs/*/approve', async (route) => {
    calls.push('approve');
    const real = await (await page.request.get(route.request().url().replace(/\/approve$/, ''))).json();
    return route.fulfill({ json: { ...real, status: 'pending' } });
  });
  await page.route('**/extraction-jobs/*/cancel', async (route) => {
    calls.push('cancel');
    const real = await (await page.request.get(route.request().url().replace(/\/cancel$/, ''))).json();
    return route.fulfill({ json: { ...real, status: 'failed', error_message: 'Cancelled before the prompt was sent to Claude.' } });
  });
  return { calls, parkedJob: () => parkedJobId };
}

async function startUpload(page: Page) {
  await page.goto('/#/new');
  await page.getByTestId('tab-new').click();
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');
}

const dialog = (page: Page) => page.getByRole('dialog', { name: /Prompt to send to Claude/ });

test('the screen shows the whole prompt and says nothing has been sent', async ({ page }) => {
  await parkFirstJob(page);
  await startUpload(page);

  await expect(dialog(page)).toBeVisible({ timeout: TIMEOUT.ui });
  await expect(dialog(page)).toHaveAttribute('aria-modal', 'true');
  await expect(dialog(page).getByRole('heading')).toHaveText('Prompt to send to Claude (classify)');
  await expect(dialog(page)).toContainText('Model claude-test-model · max 1234 tokens. Nothing has been sent yet.');

  // Every block, in order: the text in full, the document described (type, size, hash), never its bytes.
  const text = dialog(page).getByTestId('prompt-text');
  await expect(text).toHaveCount(2);
  await expect(text.nth(0)).toHaveText('first-text-block-marker');
  await expect(text.nth(1)).toHaveText('second-text-block-marker');
  await expect(dialog(page)).toContainText('system-prompt-marker'); // the system prompt follows the blocks
  const doc = dialog(page).getByTestId('prompt-document');
  await expect(doc).toHaveCount(1);
  await expect(doc).toContainText('Attached document: application/pdf, 4321 bytes, SHA-256');
  await expect(doc).toContainText('ab'.repeat(32));

  // The tool definition is there, folded away until asked for.
  const details = dialog(page).locator('details');
  await expect(details).not.toHaveAttribute('open', '');
  await details.locator('summary').click();
  await expect(details).toContainText('tool-definition-marker');
  await expect(details).toContainText('record_classification');
});

test('Send approves the job once and the flow goes on', async ({ page }) => {
  const { calls, parkedJob } = await parkFirstJob(page);
  await startUpload(page);

  await expect(dialog(page)).toBeVisible({ timeout: TIMEOUT.ui });
  expect(calls, 'nothing is answered before a button is pressed').toEqual([]);
  await expect(dialog(page).getByRole('button', { name: 'Send to Claude' })).toBeFocused();
  await dialog(page).getByRole('button', { name: 'Send to Claude' }).click();

  await expect(dialog(page)).toHaveCount(0);
  // The job goes on (a real stub job, so it finishes) and the intake carries on to the next screen.
  await page.waitForSelector('[data-testid="field-list"], [data-testid="class-row"], [data-testid="intake-error"]', { timeout: TIMEOUT.flow });
  await expect(page.getByTestId('intake-error')).toHaveCount(0);
  expect(calls).toEqual(['approve']);
  expect(parkedJob()).toBeTruthy();
});

test('Enter sends, because Send to Claude has the focus when the screen opens', async ({ page }) => {
  const { calls } = await parkFirstJob(page);
  await startUpload(page);
  await expect(dialog(page)).toBeVisible({ timeout: TIMEOUT.ui });
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => calls, { timeout: TIMEOUT.ui }).toEqual(['approve']);
});

test('Cancel cancels the job, sends nothing, and the failure is shown with Try again', async ({ page }) => {
  const { calls } = await parkFirstJob(page);
  await startUpload(page);

  await expect(dialog(page)).toBeVisible({ timeout: TIMEOUT.ui });
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();

  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId('intake-error')).toBeVisible({ timeout: TIMEOUT.ui });
  await expect(page.getByTestId('intake-error')).toContainText('Cancelled before the prompt was sent to Claude.');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  expect(calls, 'Cancel never approves').toEqual(['cancel']);
});

for (const theme of ['light', 'dark'] as const) {
  test(`the open screen has no accessibility problems (${theme})`, async ({ page, context }) => {
    await context.addInitScript((t) => {
      try {
        localStorage.setItem('sl.theme', t);
      } catch {
        /* storage unavailable */
      }
    }, theme);
    await parkFirstJob(page);
    await startUpload(page);
    await expect(dialog(page)).toBeVisible({ timeout: TIMEOUT.ui });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const problems = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`);
    expect(problems, `accessibility problems on the prompt screen (${theme})`).toEqual([]);
  });
}
