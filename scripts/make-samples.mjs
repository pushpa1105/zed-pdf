// Generate the sample PDFs in samples/pdfs/ (Chromium) plus native-print references.
import { mkdirSync, writeFileSync } from 'node:fs';
import { startServer, launch, exportInPage, nativePrint, openFixture } from './lib/browser.mjs';
import { render } from './lib/pdf-tools.mjs';

const out = new URL('../samples/pdfs/', import.meta.url);
mkdirSync(out, { recursive: true });
const footer = { html: '<div style="font:10px \'Noto Sans\',sans-serif;color:#627084;display:flex;justify-content:space-between;padding-top:6px;border-top:1px solid #d5dce4"><span>Himal Trading Co. · INV-2026-0042</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>' };
const jobs = [
  ['invoice-one-page', 'preset=one-page', {}],
  ['invoice-two-page', 'preset=two-page', {}],
  ['invoice-two-page-letter-footer', 'preset=two-page', { format: 'Letter', footer }],
  ['invoice-200-rows', 'preset=long', { footer }],
  ['invoice-1000-rows', 'preset=long&rows=1000', {}],
  ['invoice-oversized-row', 'preset=oversized', {}],
  ['invoice-missing-image', 'preset=missing-image', {}],
  ['invoice-bilingual-unshaped', 'preset=bilingual', { complexScriptFallback: 'none' }],
  ['invoice-bilingual-raster', 'preset=bilingual', { complexScriptFallback: 'raster' }],
  ['invoice-landscape', 'preset=two-page', { orientation: 'landscape' }],
];
const { server, base } = await startServer();
const browser = await launch('chromium');
const summary = [];
for (const [name, query, opts] of jobs) {
  const page = await openFixture(browser, base, query);
  const r = await exportInPage(page, '#invoice', { format: 'A4', margin: '10mm', title: name, ...opts });
  writeFileSync(new URL(`${name}.pdf`, out), r.bytes);
  summary.push({ name, pages: r.pageCount, bytes: r.bytes.length, ms: Math.round(r.ms), warnings: r.warnings.map((w) => `${w.severity}:${w.code}`) });
  if (['invoice-two-page', 'invoice-bilingual-unshaped', 'invoice-bilingual-raster', 'invoice-oversized-row'].includes(name)) {
    writeFileSync(new URL(`${name}.chromium-print.pdf`, out), await nativePrint(page, { format: 'A4', margin: '10mm' }));
  }
  if (name.startsWith('invoice-bilingual')) writeFileSync(new URL(`${name}-p1.png`, out), render(r.bytes, 110)[0].png);
  await page.close();
}
// Boundary fixtures.
for (const kind of ['exact', 'over', 'fullpage', 'multipage', 'totals', 'totals-huge', 'colspan', 'rowspan', 'header-tall', 'big-image']) {
  const page = await browser.newPage();
  await page.goto(`${base}/fixtures/boundary.html?case=${kind}`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await page.evaluate(() => document.fonts.ready);
  const r = await exportInPage(page, '#doc', { format: { width: '800px', height: '1000px' }, margin: 0 });
  writeFileSync(new URL(`boundary-${kind}.pdf`, out), r.bytes);
  summary.push({ name: `boundary-${kind}`, pages: r.pageCount, bytes: r.bytes.length, warnings: r.warnings.map((w) => `${w.severity}:${w.code}`) });
  await page.close();
}
await browser.close();
server.close();
writeFileSync(new URL('index.json', out), JSON.stringify(summary, null, 2));
console.table(summary.map((s) => ({ ...s, warnings: s.warnings.join(' ') })));
