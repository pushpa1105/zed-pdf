// Milestone 1 feasibility experiment: two-page invoice, direct export vs native Chromium print.
// Writes samples/m1/* and prints a JSON summary.
import { mkdirSync, writeFileSync } from 'node:fs';
import { startServer, launch, exportInPage, nativePrint, openFixture } from './lib/browser.mjs';
import { inspect, extract, render, diffImages } from './lib/pdf-tools.mjs';

const outDir = new URL('../samples/m1/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const { server, base } = await startServer();
const browser = await launch('chromium');
try {
  const page = await openFixture(browser, base, 'preset=two-page');
  const ours = await exportInPage(page, '#invoice', { format: 'A4', margin: '10mm', title: 'Invoice INV-2026-0042' });
  const ref = await nativePrint(page, { format: 'A4', margin: '10mm' });
  // Chromium quantizes the requested 210x297mm paper to 595.92x841.92pt and 10mm margins to 37px;
  // a geometry-matched export
  // isolates layout fidelity from that paper-size rounding.
  const matched = await exportInPage(page, '#invoice', { format: { width: '595.92pt', height: '841.92pt' }, margin: '37px' });
  writeFileSync(new URL('invoice-zedpdf-matched.pdf', outDir), matched.bytes);
  writeFileSync(new URL('invoice-zedpdf.pdf', outDir), ours.bytes);
  writeFileSync(new URL('invoice-chromium-print.pdf', outDir), ref);

  const summary = { browser: `chromium ${browser.version()}`, zedpdf: {}, print: {} };
  for (const [k, bytes] of [['zedpdf', ours.bytes], ['print', ref]]) {
    const info = await inspect(bytes);
    const pages = await extract(bytes);
    const renders = render(bytes, 96);
    renders.forEach((r, i) => writeFileSync(new URL(`${k}-p${i + 1}.png`, outDir), r.png));
    summary[k] = { ...info, bytes: bytes.length, text: pages.map((p) => p.text), renders };
  }
  // Compare: ITEM ids, grand total, positions of each id.
  const pos = (pages) => {
    const m = new Map();
    pages.forEach((p, pi) => p.items.forEach((it) => {
      for (const id of it.str.match(/ITEM-\d{4}/g) ?? []) if (!m.has(id)) m.set(id, { page: pi, x: it.x, y: it.y });
    }));
    return m;
  };
  const pa = pos(await extract(matched.bytes));
  const pb = pos(await extract(ref));
  let maxDx = 0, maxDy = 0, samePage = 0;
  for (const [id, a] of pa) {
    const b = pb.get(id);
    if (!b) continue;
    if (a.page === b.page) {
      samePage++;
      maxDx = Math.max(maxDx, Math.abs(a.x - b.x));
      maxDy = Math.max(maxDy, Math.abs(a.y - b.y));
    }
  }
  const diffs = [];
  const matchedRenders = render(matched.bytes, 96);
  const n = Math.min(matchedRenders.length, summary.print.renders.length);
  for (let i = 0; i < n; i++) {
    const d = diffImages(matchedRenders[i], summary.print.renders[i]);
    writeFileSync(new URL(`diff-p${i + 1}.png`, outDir), d.png);
    diffs.push(+(d.ratio * 100).toFixed(2));
  }
  const report = {
    browser: summary.browser,
    zedpdf: { pages: ours.pageCount, bytes: ours.bytes.length, ms: Math.round(ours.ms), timings: ours.timings, inspect: { ...summary.zedpdf, text: undefined, renders: undefined }, warnings: ours.warnings },
    print: { bytes: ref.length, inspect: { ...summary.print, text: undefined, renders: undefined } },
    compare: { idsInBoth: pa.size, idsOnSamePage: samePage, maxDxPt: +maxDx.toFixed(2), maxDyPt: +maxDy.toFixed(2), pixelDiffPercentPerPage: diffs },
    zedpdfTextPage1: summary.zedpdf.text[0].slice(0, 600),
  };
  writeFileSync(new URL('report.json', outDir), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.close();
}
