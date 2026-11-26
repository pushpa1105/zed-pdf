// Actions: declarative buttons (script-tag build, no app JavaScript) and the chainable pdf() API.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { open, extract } from './helpers.mjs';

const events = (page) => page.evaluate(() => window.__events);

test('declarative buttons: download, preview, open, share fallback, print, error event @compat', async ({ page, context, browserName }) => {
  await open(page, '/fixtures/actions.html');

  // download: file name from data-zedpdf-filename, busy state while running, done event
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#b-download'),
    expect(page.locator('#b-download')).toHaveAttribute('aria-busy', 'true'),
  ]);
  expect(dl.suggestedFilename()).toBe('INV-2026-0042.pdf');
  const pages = await extract(readFileSync(await dl.path()));
  expect(pages[0].text).toContain('ITEM-0001');
  await expect(page.locator('#b-download')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#b-download')).toBeEnabled();

  // preview: an iframe is created inside #viewer and gets a blob: URL; a second preview replaces it
  await page.click('#b-preview');
  const frame = page.locator('#viewer > iframe[data-zedpdf-preview]');
  await expect(frame).toHaveAttribute('src', /^blob:/);
  const first = await frame.getAttribute('src');
  await page.click('#b-preview');
  await expect(frame).not.toHaveAttribute('src', first);
  await expect(page.locator('#viewer > iframe')).toHaveCount(1);

  // open: a tab is opened inside the click (popup-safe), then pointed at the PDF
  if (browserName === 'chromium') {
    // Headless Chromium has no PDF viewer: the new tab receives the PDF as a download instead of showing it.
    const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#b-open')]);
    const got = await Promise.race([
      popup.waitForEvent('download').then(async (d) => (await extract(readFileSync(await d.path()))).length),
      expect.poll(() => popup.url()).toMatch(/^blob:/).then(() => 'viewer'),
    ]);
    expect(got === 'viewer' || got === 1).toBe(true);
    await popup.close().catch(() => {});
  }

  // share: no share sheet in a headless browser, so it falls back to a download
  const [shared] = await Promise.all([page.waitForEvent('download'), page.click('#b-share')]);
  // WebKit reports share support but refuses it headlessly; its fallback download keeps no name.
  if (browserName !== 'webkit') expect(shared.suggestedFilename()).toBe('Invoice-42.pdf');
  expect((await extract(readFileSync(await shared.path()))).length).toBe(1);

  // print: intercept print() on the export surface (a real dialog cannot be driven headlessly)
  await page.evaluate(() => {
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.tagName === 'IFRAME' && n.title === 'zedpdf export surface') {
        const hook = () => (n.contentWindow ? (n.contentWindow.print = () => { window.__printed = n.contentDocument.body.innerText.includes('INVOICE'); n.contentWindow.dispatchEvent(new Event('afterprint')); }) : setTimeout(hook, 0));
        hook();
      }
    }).observe(document.body, { childList: true });
  });
  await page.click('#b-print');
  await expect.poll(() => page.evaluate(() => window.__printed)).toBe(true);

  // a missing target reports an error event instead of throwing into the page
  await page.click('#b-missing');
  await expect.poll(async () => (await events(page)).some((e) => e.id === 'b-missing' && e.type === 'zedpdf:error' && e.error === 'invalid-element')).toBe(true);

  const ev = await events(page);
  expect(ev.filter((e) => e.type === 'zedpdf:done').map((e) => e.action)).toEqual(
    expect.arrayContaining(['download', 'preview', 'share', 'print']),
  );
  expect(ev.find((e) => e.action === 'share' && e.type === 'zedpdf:done').outcome).toBe('downloaded');
  expect(await page.evaluate(() => document.querySelectorAll('iframe[title="zedpdf export surface"]').length)).toBe(0);
});

test('chainable API and result actions', async ({ page }) => {
  await open(page, '/fixtures/actions.html');
  const r = await page.evaluate(async () => {
    const { pdf, exportPdf } = await import('/packages/zedpdf/dist/zedpdf.js');
    const doc = pdf('#invoice', { format: 'A4', title: 'Invoice INV-2026-0042' });
    const file = await doc.file();
    const blob = await doc.blob({ margin: '20mm' });
    const result = await exportPdf(document.querySelector('#invoice'), { filename: 'statement' });
    const url = result.url();
    const sameUrl = result.url() === url;
    const okBefore = (await fetch(url)).ok;
    result.dispose();
    const revoked = await fetch(url).then(() => false, () => true);
    let missing = null;
    try {
      await pdf('#does-not-exist').blob();
    } catch (e) {
      missing = e.code;
    }
    return {
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
      blobType: blob.type,
      resultName: result.filename,
      fileFromResult: result.file().name,
      pages: result.pageCount,
      sameUrl,
      okBefore,
      revoked,
      missing,
    };
  });
  expect(r).toEqual({
    fileName: 'Invoice-INV-2026-0042.pdf',
    fileType: 'application/pdf',
    fileSize: expect.any(Number),
    blobType: 'application/pdf',
    resultName: 'statement.pdf',
    fileFromResult: 'statement.pdf',
    pages: 1,
    sameUrl: true,
    okBefore: true,
    revoked: true,
    missing: 'invalid-element',
  });
  expect(r.fileSize).toBeGreaterThan(10_000);
});
