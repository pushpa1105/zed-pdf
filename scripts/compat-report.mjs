// Cross-engine compatibility report: export each invoice preset in Chromium, Firefox and WebKit
// (Playwright 1.65.1 builds) and verify the PDF independently. Writes samples/compat/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { startServer, launch, exportInPage, openFixture } from './lib/browser.mjs';
import { inspect, extract, render } from './lib/pdf-tools.mjs';

const out = new URL('../samples/compat/', import.meta.url);
mkdirSync(out, { recursive: true });
const cases = [
  ['two-page', {}],
  ['long', {}],
  ['oversized', {}],
  ['missing-image', {}],
  ['bilingual', { complexScriptFallback: 'raster' }],
];
const { server, base } = await startServer();
const rows = [];
for (const engine of ['chromium', 'firefox', 'webkit']) {
  const browser = await launch(engine);
  for (const [preset, opts] of cases) {
    const page = await openFixture(browser, base, `preset=${preset}`);
    const fx = await page.evaluate(() => window.__fixture);
    let row = { engine, version: browser.version(), preset };
    try {
      const r = await exportInPage(page, '#invoice', { format: 'A4', margin: '10mm', ...opts });
      const info = await inspect(r.bytes);
      const pages = await extract(r.bytes);
      const text = pages.map((p) => p.text).join('\n');
      const ids = text.match(/ITEM-\d{4}/g) ?? [];
      row = {
        ...row,
        ok: true,
        pages: r.pageCount,
        ms: Math.round(r.ms),
        bytes: r.bytes.length,
        valid: info.xref.ok && info.mupdfRepaired === false && info.pdfjsPages === r.pageCount,
        idsOnceInOrder: JSON.stringify(ids) === JSON.stringify(fx.ids),
        grandOnce: text.split(fx.grand).length - 1 === 1,
        warnings: r.warnings.filter((w) => w.severity !== 'info').map((w) => w.code),
      };
      if (preset === 'two-page' || preset === 'bilingual') writeFileSync(new URL(`${engine}-${preset}-p1.png`, out), render(r.bytes, 72)[0].png);
      writeFileSync(new URL(`${engine}-${preset}.pdf`, out), r.bytes);
    } catch (e) {
      row = { ...row, ok: false, error: String(e.message ?? e).slice(0, 300) };
    }
    rows.push(row);
    console.log(JSON.stringify(row));
    await page.close();
  }
  await browser.close();
}
server.close();
writeFileSync(new URL('report.json', out), JSON.stringify(rows, null, 2));
