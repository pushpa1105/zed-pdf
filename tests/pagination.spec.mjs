// Boundary fixtures with exact geometry: 800x1000 CSS px content area, 40px table header.
import { test, expect } from '@playwright/test';
import { open, exportInPage, extract, tokens } from './helpers.mjs';

const PAGE = { format: { width: '800px', height: '1000px' }, margin: 0 };
const PT = 0.75;

async function run(page, kind, extra = {}) {
  await open(page, `/fixtures/boundary.html?case=${kind}`);
  const r = await exportInPage(page, '#doc', { ...PAGE, ...extra });
  const pages = await extract(r.bytes);
  return { r, pages, byPage: pages.map((p) => p.text) };
}
// Row ids are the whole content of the first cell (excludes 'Item R01' / 'AMT-R01').
const rowsOn = (pages) => pages.map((p) => p.items.map((it) => it.str.trim()).filter((s) => /^R\d\d$/.test(s)));

test('exact-fit row stays on the current page', async ({ page }) => {
  const { pages } = await run(page, 'exact');
  const rows = rowsOn(pages);
  expect(rows[0]).toEqual(['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10', 'R11', 'R12']);
  expect(rows[1]).toEqual(['R13', 'R14']);
});

test('row just over the remaining space moves intact', async ({ page }) => {
  const { pages } = await run(page, 'over');
  const rows = rowsOn(pages);
  expect(rows[0].at(-1)).toBe('R11');
  expect(rows[1][0]).toBe('R12');
  // R12 (id + amount) appears exactly once.
  expect(pages.map((p) => p.text).join('\n').split('AMT-R12').length - 1).toBe(1);
});

test('full-page row occupies a fresh page under the repeated header', async ({ page }) => {
  const { pages } = await run(page, 'fullpage');
  expect(rowsOn(pages)).toEqual([['R01'], ['R02'], ['R03']]);
  for (const p of pages) expect(p.text).toContain('Description');
  const r2 = tokens(pages, /\bR02\b/g)[0];
  expect(r2.page).toBe(1);
});

test('multi-page row: every line once and in order, amount painted once, next rows resume after', async ({ page }) => {
  const { pages } = await run(page, 'multipage');
  const lines = tokens(pages, /LINE-\d{3}/g).map((t) => t.tok);
  expect(lines).toEqual(Array.from({ length: 120 }, (_, i) => `LINE-${String(i + 1).padStart(3, '0')}`));
  const all = pages.map((p) => p.text).join('\n');
  expect(all.split('AMT-MULTI').length - 1).toBe(1);
  expect(rowsOn(pages).flat()).toEqual(['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07']);
  expect(pages.length).toBeGreaterThanOrEqual(3);
  // R05 starts only after the last line of R04.
  const last = tokens(pages, /LINE-120/g)[0];
  const r5 = tokens(pages, /\bR05\b/g)[0];
  expect(r5.page > last.page || (r5.page === last.page && r5.y > last.y)).toBe(true);
  // Header repeated on continuation pages.
  for (const p of pages) expect(p.text).toContain('Amount');
});

test('keep-together totals block moves intact; a block taller than a page splits with a diagnostic', async ({ page }) => {
  const a = await run(page, 'totals');
  const t = tokens(a.pages, /TOTAL-LINE-\d+/g);
  expect(new Set(t.map((x) => x.page))).toEqual(new Set([1]));
  expect(t.length).toBe(15);
  const b = await run(page, 'totals-huge');
  const t2 = tokens(b.pages, /TOTAL-LINE-\d+/g);
  expect(t2.map((x) => x.tok)).toEqual(Array.from({ length: 75 }, (_, i) => `TOTAL-LINE-${i + 1}`));
  expect(b.byPage.join('\n').split('GRAND-TOTAL').length - 1).toBe(1);
  expect(b.r.warnings.some((w) => w.code === 'break-inside-relaxed')).toBe(true);
});

test('colspan keeps column positions across pages', async ({ page }) => {
  const { pages } = await run(page, 'colspan');
  const amts = tokens(pages, /AMT-(R\d\d|SPAN)/g);
  const rights = amts.map((a) => a.x + a.w);
  expect(Math.max(...rights) - Math.min(...rights)).toBeLessThan(0.3);
  const span = tokens(pages, /SPANNED-DESCRIPTION/g)[0];
  const id = tokens(pages, /\bR01\b/g)[0];
  expect(Math.abs(span.x - id.x)).toBeLessThan(0.3); // spanned cell starts in column 1
  expect(rowsOn(pages).flat().length).toBe(35);
});

test('rowspan group that fits is moved intact to the next page', async ({ page }) => {
  const { pages } = await run(page, 'rowspan');
  const g = tokens(pages, /ROWSPAN-CELL|AMT-R12|AMT-R13/g);
  expect(new Set(g.map((x) => x.page)).size).toBe(1);
  expect(g[0].page).toBe(1);
});

test('header too tall to repeat is reported; body rows still fit', async ({ page }) => {
  const { r, pages } = await run(page, 'header-tall');
  expect(r.warnings.some((w) => w.code === 'table-header-not-repeated')).toBe(true);
  expect(rowsOn(pages).flat().length).toBe(20);
  expect(pages[1].text).not.toContain('Very tall header');
});

test('oversized indivisible image: scaled to fit by default, sliced on request', async ({ page }) => {
  const a = await run(page, 'big-image');
  expect(a.r.warnings.some((w) => w.code === 'oversized-image-scaled')).toBe(true);
  expect(a.byPage.join('').split('AFTER-IMAGE').length - 1).toBe(1);
  const b = await run(page, 'big-image', { oversizedImage: 'slice' });
  expect(b.r.warnings.some((w) => w.code === 'monolithic-sliced')).toBe(true);
  // Image moves to a fresh page (page 2) and is sliced over pages 2-3; AFTER-IMAGE follows it.
  expect(b.pages.length).toBeGreaterThanOrEqual(3);
  expect(b.byPage.join('').split('AFTER-IMAGE').length - 1).toBe(1);
});

test('every page consumes content: no blank pages anywhere', async ({ page }) => {
  for (const kind of ['exact', 'over', 'fullpage', 'multipage', 'totals', 'totals-huge', 'colspan', 'rowspan', 'header-tall']) {
    const { pages } = await run(page, kind);
    for (const p of pages) expect(p.text.trim().length, `${kind}`).toBeGreaterThan(0);
  }
});
