import { type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { seedReport } from './helpers/api';
import { openReviewFromList } from './helpers/ui';
import { uniqueFixture } from './unique-upload';

// iOS Safari zooms the whole page when a text box with a font under 16px gets focus, and the zoom stays until the
// person pinches back. So every typing control on a phone screen must be at least 16px (docs: claude/plan-phone-e2e-tests.md,
// iPhone follow-up). It runs in Chromium and, nightly, in the iPhone profile.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function smallTypingControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sel = 'input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]):not([type=range]):not([type=button]):not([type=submit]), textarea, select';
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.display === 'none') continue;
      if (parseFloat(s.fontSize) < 16) {
        const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('data-testid') || el.id || el.getAttribute('name') || '';
        out.push(`${el.tagName.toLowerCase()}${(el as HTMLInputElement).type ? `[${(el as HTMLInputElement).type}]` : ''} ${s.fontSize} "${label.slice(0, 30)}"`);
      }
    }
    return out;
  });
}

test.describe('typing controls on a phone', { tag: '@phone' }, () => {
  for (const [name, hash] of [
    ['Home', '/#/home'],
    ['New report', '/#/new'],
    ['Reports', '/#/reports'],
    ['Analytics', '/#/analytics'],
    ['Instruments', '/#/instruments'],
    ['Templates', '/#/templates'],
    ['Admin', '/#/admin'],
  ] as const) {
    test(`${name}: every text box, number box and menu is at least 16px, so iPhone Safari does not zoom in`, async ({ page }) => {
      await page.goto(hash);
      await page.waitForLoadState('networkidle');
      // Filters start folded on a phone; open them so their boxes are measured too.
      const show = page.getByRole('button', { name: /Show filters/ });
      if (await show.count()) await show.first().click();
      expect(await smallTypingControls(page)).toEqual([]);
    });
  }

  test('the review screen: the field boxes are at least 16px', async ({ page, request }) => {
    const marker = `E2E-InputSize-${Date.now()}`;
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker });
    await openReviewFromList(page, marker);
    await expect(page.getByTestId('field-list')).toBeVisible();
    expect(await smallTypingControls(page)).toEqual([]);
  });

  test('the add-instrument form: every box is at least 16px', async ({ page }) => {
    await page.goto('/#/instruments');
    const add = page.getByRole('button', { name: /Add instrument|Add an instrument|\+ Instrument/ });
    if (await add.count()) await add.first().click();
    expect(await smallTypingControls(page)).toEqual([]);
  });
});
