// Invoice correctness: validity, extraction, repeated headers, geometry, fidelity vs native print.
import { test, expect } from '@playwright/test';
import { open, exportInPage, nativePrint, extract, inspect, render, diffImages, tokens, flatItems, pdfObjects } from './helpers.mjs';

const A4 = { w: 595.28, h: 841.89 };
const MARGIN_PT = (10 / 25.4) * 72;

test('M1: two-page invoice is a valid PDF, extracts cleanly and matches native print @compat', async ({ page, browserName }) => {
  await open(page, '/fixtures/invoice.html?preset=two-page');
  const r = await exportInPage(page, '#invoice', { format: 'A4', margin: '10mm' });
  const info = await inspect(r.bytes);
  expect(info.mupdfRepaired).toBe(false);
  expect(info.xref.ok).toBe(true);
  expect(info.mupdfPages).toBe(r.pageCount);
  expect(info.pdfjsPages).toBe(r.pageCount);
  expect(render(r.bytes, 30).length).toBe(r.pageCount);
  const pages = await extract(r.bytes);
  const text = pages.map((p) => p.text).join('\n');
  const fx = await page.evaluate(() => window.__fixture);
  expect(text.match(/ITEM-\d{4}/g)).toEqual(fx.ids);
  expect(text.split(fx.grand).length - 1).toBe(1);
  expect(text).not.toContain('SCREEN-ONLY'); // @media screen rule disabled on the direct path
  expect(text).toContain('€ / $ / £ / ₹'); // currency symbols from the embedded font
  expect(text).toContain('−'); // U+2212 minus
  expect(r.warnings.filter((w) => w.severity !== 'info')).toEqual([]);
  if (browserName === 'chromium') {
    const ref = await nativePrint(page);
    expect((await extract(ref)).length).toBe(r.pageCount);
  }
});

test('M1: geometry-matched export is within tolerance of Chromium print', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'native print reference is Chromium');
  await open(page, '/fixtures/invoice.html?preset=two-page');
  // Chromium print quantizes 210x297mm to 595.92x841.92pt and 10mm margins to 37px.
  const r = await exportInPage(page, '#invoice', { format: { width: '595.92pt', height: '841.92pt' }, margin: '37px' });
  const ref = await nativePrint(page);
  const a = tokens(await extract(r.bytes), /ITEM-\d{4}|\d{1,3}(?:,\d{3})*\.\d{2}/g);
  const b = tokens(await extract(ref), /ITEM-\d{4}|\d{1,3}(?:,\d{3})*\.\d{2}/g);
  expect(a.length).toBe(b.length);
  let maxD = 0;
  a.forEach((t, i) => {
    expect(t.tok).toBe(b[i].tok);
    expect(t.page).toBe(b[i].page);
    maxD = Math.max(maxD, Math.abs(t.x - b[i].x), Math.abs(t.y - b[i].y));
  });
  expect(maxD).toBeLessThan(0.75); // pt; documented tolerance (1 CSS px = 0.75pt)
  const ra = render(r.bytes, 96);
  const rb = render(ref, 96);
  for (let i = 0; i < ra.length; i++) expect(diffImages(ra[i], rb[i]).ratio).toBeLessThan(0.01);
});

test('200 uniquely numbered rows: each id once in order, total once, header on every row page', async ({ page }) => {
  await open(page, '/fixtures/invoice.html?preset=long');
  const r = await exportInPage(page, '#invoice', { format: 'A4', margin: '10mm' });
  const pages = await extract(r.bytes);
  const fx = await page.evaluate(() => window.__fixture);
  const ids = tokens(pages, /ITEM-\d{4}/g);
  expect(ids.map((t) => t.tok)).toEqual(fx.ids);
  expect(new Set(ids.map((t) => t.tok)).size).toBe(200);
  const all = pages.map((p) => p.text).join('\n');
  expect(all.split(fx.grand).length - 1).toBe(1);
  expect(all.split('GRAND TOTAL NPR').length - 1).toBe(1);
  pages.forEach((p, pi) => {
    const rowsHere = ids.filter((t) => t.page === pi);
    if (!rowsHere.length) return;
    const hdr = p.items.find((it) => it.str.includes('Unit price'));
    expect(hdr, `header on page ${pi + 1}`).toBeTruthy();
    expect(hdr.y).toBeLessThan(rowsHere[0].y);
  });
  // No trailing blank page: the last page has content.
  expect(pages[pages.length - 1].text.trim().length).toBeGreaterThan(0);
});

test('geometry: no column drift, no overlap, nothing outside the printable area, logo not distorted', async ({ page }) => {
  await open(page, '/fixtures/invoice.html?preset=long');
  const r = await exportInPage(page, '#invoice', { format: 'A4', margin: '10mm' });
  const pages = await extract(r.bytes);
  const items = flatItems(pages);
  // Whitespace-only items are pdf.js's synthetic gap fillers, not drawn glyphs.
  for (const it of items.filter((i) => i.str.trim())) {
    expect(it.x).toBeGreaterThanOrEqual(MARGIN_PT - 0.5);
    expect(it.x + it.w).toBeLessThanOrEqual(A4.w - MARGIN_PT + 0.5);
    expect(it.y).toBeLessThanOrEqual(A4.h - MARGIN_PT + 0.5);
  }
  // Amount column (right-aligned) keeps the same right edge on every page.
  const amounts = items.filter((it) => /^\d{1,3}(,\d{3})*\.\d{2}$/.test(it.str) && it.x > 480 && it.y < A4.h - 200);
  const rights = amounts.map((a) => a.x + a.w);
  expect(Math.max(...rights) - Math.min(...rights)).toBeLessThan(0.5);
  // Row ids are strictly increasing in y within a page and never overlap (>= one line apart).
  const ids = tokens(pages, /ITEM-\d{4}/g);
  for (let i = 1; i < ids.length; i++) if (ids[i].page === ids[i - 1].page) expect(ids[i].y - ids[i - 1].y).toBeGreaterThan(9);
  // Logo drawn at its natural aspect ratio (480x160 = 3:1).
  const objs = pdfObjects(r.bytes);
  const content = objs.filter((o) => o.data && /Filter \/FlateDecode \/Length \d+ >>/.test(o.dict) && !/Length1|Subtype/.test(o.dict)).map((o) => o.data.toString('latin1'));
  const draws = content.join('\n').match(/([\d.]+) 0 0 -([\d.]+) [\d.]+ [\d.]+ cm \/Im\d+ Do/g) ?? [];
  const logo = draws.map((d) => d.split(' ').map(Number)).find(([w, , , h]) => Math.abs(Math.abs(w / h) - 3) < 0.05);
  expect(logo, 'logo draw with 3:1 ratio').toBeTruthy();
});

test('missing image: export succeeds with a located asset warning; strict mode rejects', async ({ page }) => {
  await open(page, '/fixtures/invoice.html?preset=missing-image');
  const r = await exportInPage(page, '#invoice', { format: 'A4' });
  const w = r.warnings.find((x) => x.code === 'asset-unavailable');
  expect(w).toBeTruthy();
  expect(w.message).toContain('does-not-exist.png');
  expect(w.element).toContain('img');
  const strict = await page.evaluate(async () => {
    const { exportPdf } = await import('/packages/zedpdf/dist/zedpdf.js');
    try {
      await exportPdf(document.querySelector('#invoice'), { strict: true });
      return 'resolved';
    } catch (e) {
      return { name: e.name, code: e.code, n: e.warnings.length, iframes: document.querySelectorAll('iframe').length };
    }
  });
  expect(strict).toEqual({ name: 'ZedPdfError', code: 'fidelity', n: expect.any(Number), iframes: 0 });
});

test('oversized description row: split at line boundaries, amount painted once, matches print page count', async ({ page }) => {
  await open(page, '/fixtures/invoice.html?preset=oversized');
  const r = await exportInPage(page, '#invoice', { format: 'A4', margin: '10mm' });
  const ref = await nativePrint(page);
  expect(r.pageCount).toBe((await extract(ref)).length);
  const pages = await extract(r.bytes);
  const all = pages.map((p) => p.text).join('\n');
  expect(all.split('334.04').length - 1).toBe(1);
  expect(all.match(/ITEM-\d{4}/g)).toEqual(['ITEM-0001', 'ITEM-0002', 'ITEM-0003', 'ITEM-0004', 'ITEM-0005', 'ITEM-0006', 'ITEM-0007', 'ITEM-0008']);
});

test('explicit <br>, mixed inline styles and repeated image are handled', async ({ page }) => {
  await open(page, '/fixtures/invoice.html?preset=two-page');
  const r = await exportInPage(page, '#invoice', { format: 'A4' });
  // pdf.js flags an end-of-line at font switches on the same baseline; normalize whitespace.
  const text = (await extract(r.bytes)).map((p) => p.text).join('\n');
  expect(text.replace(/\s+/g, ' ')).toContain('Thermal printer roll — priority express delivery with signature on');
  expect(text).toMatch(/receipt\s*\n\s*Line two after an explicit break/);
  // Fonts embedded once per face, with subset tags.
  const objs = pdfObjects(r.bytes);
  const type0 = objs.filter((o) => /\/Subtype \/Type0/.test(o.dict)).map((o) => /BaseFont \/([A-Z]{6}\+[\w-]+)/.exec(o.dict)[1]);
  expect(new Set(type0.map((n) => n.split('+')[1])).size).toBe(type0.length);
  expect(type0.some((n) => /NotoSans-Bold/.test(n))).toBe(true);
});

test('cancellation rejects with "aborted" and removes the export surface', async ({ page }) => {
  await open(page, '/fixtures/invoice.html?preset=long');
  const res = await page.evaluate(async () => {
    const { exportPdf } = await import('/packages/zedpdf/dist/zedpdf.js');
    const out = [];
    for (const delay of [0, 5, 30, 80]) {
      const ac = new AbortController();
      const p = exportPdf(document.querySelector('#invoice'), { signal: ac.signal });
      setTimeout(() => ac.abort(), delay);
      try {
        await p;
        out.push('completed');
      } catch (e) {
        out.push(e.code);
      }
      out.push(document.querySelectorAll('iframe').length);
    }
    return out;
  });
  for (let i = 1; i < res.length; i += 2) expect(res[i]).toBe(0);
  expect(res.filter((x) => x === 'aborted').length).toBeGreaterThanOrEqual(2);
  // The original UI is untouched: scroll position and DOM.
  expect(await page.evaluate(() => document.querySelectorAll('#invoice table.items tbody tr').length)).toBe(200);
});
