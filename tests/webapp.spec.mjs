// Kitchen-sink web-app page: nested tables, lists, details, pre/code, multi-column text, grid cards,
// canvas chart, repeated SVG icons, forms, links. Every marker must appear exactly once, in order.
import { test, expect } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { open, exportInPage, nativePrint, extract, pdfObjects } from './helpers.mjs';

const seq = (p, n, pad = 2) => Array.from({ length: n }, (_, i) => `${p}${String(i + 1).padStart(pad, '0')}`);

test('kitchen-sink web app: complete, ordered, nested tables split cleanly, links clickable @compat', async ({ page, browserName }) => {
  await open(page, '/fixtures/webapp.html');
  const r = await exportInPage(page, '#report', { format: 'A4', margin: '10mm' });
  const pages = await extract(r.bytes);
  const text = pages.map((p) => p.text).join('\n');
  expect(text.match(/KS-\d\d/g)).toEqual(seq('KS-', 31));
  expect(text.match(/NEST-\d/g)).toEqual(['NEST-1', 'NEST-2', 'NEST-3']);
  expect(text.match(/DEEP-\d\d/g)).toEqual(seq('DEEP-', 40));
  expect(text.match(/ICON-\d/g)).toEqual(seq('ICON-', 6, 1)); // multi-column list read column by column
  expect(text).not.toContain('KS-HIDDEN'); // closed <details>
  expect(text).not.toContain('App navigation bar'); // outside the exported element
  expect(text.split('DEEP-TOTAL').length - 1).toBe(1); // outer cell painted once although the row spans pages
  // The nested table repeats its own header on the continuation page, under the outer header.
  const cont = pages.find((p) => p.text.includes('DEEP-25'));
  expect(cont.text).toContain('Region');
  expect(cont.text).toContain('Units');
  // No fidelity warnings (info only: SVG icons rasterized, form controls approximated, monospace).
  expect(r.warnings.filter((w) => w.severity !== 'info')).toEqual([]);
  // Two icon colours → two rasters (identical markup, different currentColor), plus the canvas.
  const images = pdfObjects(r.bytes).filter((o) => /Subtype \/Image/.test(o.dict) && !/DeviceGray/.test(o.dict));
  expect(images.length).toBe(3);
  // Links are real annotations with their URLs.
  const doc = await getDocument({ data: new Uint8Array(r.bytes), verbosity: 0 }).promise;
  const urls = (await (await doc.getPage(1)).getAnnotations()).filter((a) => a.subtype === 'Link').map((a) => a.url);
  expect(urls).toEqual(['https://example.com/terms?ref=q3', 'mailto:ops@example.com']);
  if (browserName === 'chromium') {
    await page.addStyleTag({ content: '@media print { body > *:not(#report) { display: none !important } #report { margin: 0 !important; max-width: none !important } body { background: #fff } }' });
    const ref = await extract(await nativePrint(page));
    expect(Math.abs(ref.length - pages.length)).toBeLessThanOrEqual(1);
  }
});
