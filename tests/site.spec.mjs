// Showcase site (dist-site/, built by `pnpm site`): live playground, docs page, light/dark themes.
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { extract } from './helpers.mjs';

test.skip(!existsSync('dist-site/index.html'), 'run `pnpm site` first');

async function noBrokenImages(page) {
  return page.evaluate(async () => {
    const imgs = [...document.querySelectorAll('img')];
    await Promise.all(imgs.map((i) => ((i.loading = 'eager'), i.decode().catch(() => {}))));
    return imgs.filter((i) => !i.naturalWidth && !i.src.includes('does-not-exist')).map((i) => i.getAttribute('src'));
  });
}

test('site: playground generates and downloads a real PDF', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/dist-site/');
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  expect(await noBrokenImages(page)).toEqual([]);
  await page.click('#generate');
  await expect(page.locator('#stats')).toContainText('3 pages');
  await expect(page.locator('#pdf')).toBeVisible();
  await expect(page.locator('#empty')).toBeHidden();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const pages = await extract(readFileSync(await dl.path()));
  expect(pages.length).toBe(3);
  expect(pages[0].text).toContain('ITEM-0001');
  const fits = await page.evaluate(() => document.querySelector('#invoice').getBoundingClientRect().right <= document.querySelector('.html-view').getBoundingClientRect().right + 1);
  expect(fits).toBe(true);
  // Install tabs switch the command; code tabs switch panes.
  await page.click('.install [role=tab]:nth-child(4)');
  await expect(page.locator('#install-cmd')).toContainText('zedpdf.global.js');
  await page.click('#start [role=tab][data-pane=react]');
  await expect(page.locator('#start pre[data-pane=react]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('site: light/dark theme follows the OS, toggles and persists; screenshots', async ({ browser }) => {
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto('/dist-site/');
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(scheme);
    await page.screenshot({ path: `samples/site-${scheme}.png` });
    await page.goto('/dist-site/docs.html');
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
    await page.screenshot({ path: `samples/site-docs-${scheme}.png` });
    await ctx.close();
  }
  const ctx = await browser.newContext({ colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto('/dist-site/');
  await page.click('[data-theme-toggle]');
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark'); // persisted
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(23, 22, 18)');
  await ctx.close();
});

test('docs: every sidebar and in-page link resolves; code tabs work; no broken images', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/dist-site/docs.html');
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  const missing = await page.evaluate(() =>
    [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href').slice(1)).filter((id) => id && !document.getElementById(id)),
  );
  expect(missing).toEqual([]);
  expect(await noBrokenImages(page)).toEqual([]);
  await page.click('#frameworks [role=tab][data-pane=angular]');
  await expect(page.locator('#frameworks pre[data-pane=angular]')).toBeVisible();
  await page.click('.sidebar a[href="#api"]');
  await expect(page.locator('.sidebar a[href="#api"]')).toHaveClass(/active/);
  await expect(page.locator('#api table')).toContainText('maxImageDpi');
  expect(errors).toEqual([]);
});

test('site: changelog page renders CHANGELOG.md; no unreplaced placeholders', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const { version } = JSON.parse(readFileSync('packages/zedpdf/package.json', 'utf8'));
  await page.goto('/dist-site/changelog.html');
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await expect(page.locator(`.cl-release#v${version.replace(/[^0-9A-Za-z]+/g, '-')} h2`)).toHaveText(version);
  await expect(page.locator('.cl-release').first().locator('.cl-group').first()).toBeVisible();
  await expect(page.locator('#ver')).toHaveText(`v${version}`);
  for (const file of ['index.html', 'docs.html', 'changelog.html']) {
    expect(readFileSync(`dist-site/${file}`, 'utf8')).not.toMatch(/\{\{[A-Z_]+\}\}|CHANGELOG:(NAV|BODY)/);
  }
  expect(readFileSync('dist-site/docs.html', 'utf8')).toContain(`zedpdf@${version}/dist/zedpdf.js`);
  expect(errors).toEqual([]);
});
