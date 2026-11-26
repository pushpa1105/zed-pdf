// Shared Playwright helpers: serve the repo, export an element with zedpdf, print the same page natively.
import { chromium, firefox, webkit } from '@playwright/test';
import { serve } from '../serve.mjs';

export async function startServer() {
  const port = 4300 + Math.floor(Math.random() * 600);
  const server = await serve(port);
  return { server, base: `http://127.0.0.1:${port}` };
}

export async function launch(name = 'chromium', opts = {}) {
  return { chromium, firefox, webkit }[name].launch(opts);
}

/** Run exportPdf in the page on `selector`; returns bytes + metadata. */
export async function exportInPage(page, selector, options = {}) {
  const r = await page.evaluate(
    async ({ selector, options }) => {
      const { exportPdf } = await import('/packages/zedpdf/dist/zedpdf.js');
      const el = document.querySelector(selector);
      const t0 = performance.now();
      const res = await exportPdf(el, options);
      const ms = performance.now() - t0;
      const buf = new Uint8Array(await res.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { b64: btoa(s), pageCount: res.pageCount, warnings: res.warnings, timings: res.timings, ms };
    },
    { selector, options },
  );
  return { ...r, bytes: Buffer.from(r.b64, 'base64') };
}

/** Native Chromium print-to-PDF reference with matching paper settings. */
const PAPER = { A4: ['210mm', '297mm'], Letter: ['8.5in', '11in'] };
export async function nativePrint(page, { format = 'A4', margin = '10mm', landscape = false } = {}) {
  // Exact paper sizes (Playwright's 'A4' preset is 8.27in x 11.7in, not 210 x 297 mm).
  let [width, height] = PAPER[format];
  if (landscape) [width, height] = [height, width];
  return page.pdf({
    width,
    height,
    margin: { top: margin, right: margin, bottom: margin, left: margin },
    printBackground: true,
    displayHeaderFooter: false,
    preferCSSPageSize: false,
  });
}

export async function openFixture(browser, base, query, viewport = { width: 1200, height: 900 }) {
  const page = await browser.newPage({ viewport });
  await page.goto(`${base}/fixtures/invoice.html?${query}`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await page.evaluate(() => document.fonts.ready);
  return page;
}
