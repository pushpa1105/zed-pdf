// The demo works through its normal UI: preview shows the real Blob, download yields a valid PDF.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { extract, inspect } from './helpers.mjs';

test('demo: preview, download (with page-number footer) and preset switching', async ({ page }) => {
  await page.goto('/demo/');
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await page.click('#preview');
  await expect(page.locator('#pdf')).toHaveAttribute('src', /^blob:/);
  await expect(page.locator('#stats')).toContainText('3 pages');
  await page.screenshot({ path: 'samples/demo-screenshot.png' });

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  expect(dl.suggestedFilename()).toBe('invoice-two-page.pdf');
  const bytes = readFileSync(await dl.path());
  expect((await inspect(bytes)).xref.ok).toBe(true);
  const pages = await extract(bytes);
  expect(pages.length).toBe(3);
  pages.forEach((p, i) => expect(p.text.replace(/\s+/g, ' ')).toContain(`Page ${i + 1} of 3`));

  // Previous preview URL is revoked when replaced.
  const first = await page.locator('#pdf').getAttribute('src');
  await page.selectOption('select[name=preset]', 'missing-image');
  await page.click('#preview');
  await expect(page.locator('#pdf')).not.toHaveAttribute('src', first);
  const revoked = await page.evaluate(async (u) => fetch(u).then(() => false, () => true), first);
  expect(revoked).toBe(true);
  await expect(page.locator('#warnings')).toContainText('asset-unavailable');
  expect(await page.evaluate(() => document.querySelectorAll('iframe').length)).toBe(1); // only the preview iframe
});
