// Side-by-side comparison on the SAME invoice fixture (fixtures/invoice.html?preset=two-page):
//   html2pdf.js, pdfmake (+html-to-pdfmake), Paged.js (+Chromium print), zedpdf, native Chromium print.
// Usage (from this folder, after `npm install`):  node run.mjs
// Writes samples/compare/{<tool>.pdf,<tool>-p1.png,results.json,results.md}.
// Competitors live only in research/compare/node_modules; the library is untouched.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { startServer, launch, exportInPage, nativePrint, openFixture } from '../../scripts/lib/browser.mjs';
import { inspect, extract, render, diffImages } from '../../scripts/lib/pdf-tools.mjs';

const outDir = new URL('../../samples/compare/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const NM = '/research/compare/node_modules';
const ver = (p) => JSON.parse(readFileSync(new URL(`node_modules/${p}/package.json`, import.meta.url), 'utf8')).version;
const versions = {
  'html2pdf.js': ver('html2pdf.js'),
  pdfmake: ver('pdfmake'),
  'html-to-pdfmake': ver('html-to-pdfmake'),
  pagedjs: ver('pagedjs'),
  zedpdf: JSON.parse(readFileSync(new URL('../../packages/zedpdf/package.json', import.meta.url), 'utf8')).version,
  '@playwright/test': JSON.parse(readFileSync(new URL('../../node_modules/@playwright/test/package.json', import.meta.url), 'utf8')).version,
  node: process.version,
};

const b64ToBuf = (b64) => Buffer.from(b64, 'base64');
// In-page helper (stringified into page.evaluate bodies): ArrayBuffer/Uint8Array -> base64.
const TO_B64 = `(u8) => { let s=''; for (let i=0;i<u8.length;i+=0x8000) s+=String.fromCharCode.apply(null,u8.subarray(i,i+0x8000)); return btoa(s); }`;

// ---------- tool runners: each returns { bytes, ms, timing, notes[], extra? } or throws ----------
const tools = {
  async zedpdf(browser, base) {
    const page = await openFixture(browser, base, 'preset=two-page');
    const r = await exportInPage(page, '#invoice', { format: 'A4', margin: '10mm' });
    await page.close();
    return { bytes: r.bytes, ms: r.ms, timing: 'in-page exportPdf()', notes: r.warnings?.length ? [`zedpdf warnings: ${JSON.stringify(r.warnings)}`] : [] };
  },

  async 'chromium-print'(browser, base) {
    const page = await openFixture(browser, base, 'preset=two-page');
    const t0 = performance.now();
    const bytes = await nativePrint(page, { format: 'A4', margin: '10mm' });
    const ms = performance.now() - t0;
    await page.close();
    return { bytes: Buffer.from(bytes), ms, timing: 'Node-side page.pdf() round trip', notes: ['Prints the whole page (fixture #mount wrapper), print media.'] };
  },

  async html2pdf(browser, base) {
    const page = await openFixture(browser, base, 'preset=two-page');
    await page.addScriptTag({ url: `${base}${NM}/html2pdf.js/dist/html2pdf.bundle.min.js` });
    const r = await page.evaluate(async (toB64Src) => {
      const toB64 = eval(toB64Src);
      const el = document.querySelector('#invoice');
      const opts = {
        margin: 10,
        filename: 'invoice.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] },
      };
      const t0 = performance.now();
      const ab = await window.html2pdf().set(opts).from(el).outputPdf('arraybuffer');
      const ms = performance.now() - t0;
      return { b64: toB64(new Uint8Array(ab)), ms };
    }, TO_B64);
    await page.close();
    return {
      bytes: b64ToBuf(r.b64),
      ms: r.ms,
      timing: 'in-page html2pdf().outputPdf()',
      notes: ['Options: margin 10 (jsPDF unit mm), jsPDF a4 portrait, image jpeg 0.98, html2canvas scale 2, pagebreak css+legacy.'],
    };
  },

  async pdfmake(browser, base) {
    const page = await openFixture(browser, base, 'preset=two-page');
    for (const f of ['pdfmake/build/pdfmake.min.js', 'pdfmake/build/vfs_fonts.js', 'html-to-pdfmake/browser.js'])
      await page.addScriptTag({ url: `${base}${NM}/${f}` });
    const attempt = async (variant) =>
      page.evaluate(
        async ({ toB64Src, variant }) => {
          const toB64 = eval(toB64Src);
          const log = [];
          const t0 = performance.now();
          // Convert a CLONE so the fixture DOM is not touched.
          const clone = document.querySelector('#invoice').cloneNode(true);
          // html-to-pdfmake has no option to repeat <thead>; the documented way is data-pdfmake on <table>.
          clone.querySelector('table.items').setAttribute('data-pdfmake', '{"headerRows":1}');
          log.push('set data-pdfmake=\'{"headerRows":1}\' on table.items (html-to-pdfmake does not map <thead> to headerRows by itself)');
          if (variant === 'svg-workaround') {
            // pdfmake's `image` cannot embed SVG; replace <img src=*.svg> by inline <svg> markup (pdfmake `svg` node).
            for (const img of clone.querySelectorAll('img')) {
              if (/\.svg($|\?)/.test(img.getAttribute('src'))) {
                const txt = await (await fetch(img.src)).text();
                const holder = document.createElement('div');
                holder.innerHTML = txt;
                const svg = holder.querySelector('svg');
                svg.setAttribute('width', '80');
                svg.setAttribute('height', '40');
                img.replaceWith(svg);
                log.push(`replaced <img src=${new URL(img.src).pathname}> with inline <svg>`);
              }
            }
          }
          const conv = window.htmlToPdfmake(clone.outerHTML, { imagesByReference: true, tableAutoSize: true });
          const dd = { content: conv.content, images: conv.images, pageSize: 'A4', pageMargins: [28.35, 28.35, 28.35, 28.35], defaultStyle: { fontSize: 9 } };
          const tConv = performance.now() - t0;
          const buf = await window.pdfMake.createPdf(dd).getBuffer();
          const ms = performance.now() - t0;
          return { b64: toB64(new Uint8Array(buf)), ms, tConv, log, images: Object.values(conv.images ?? {}) };
        },
        { toB64Src: TO_B64, variant },
      );
    const notes = ['Default pdfmake fonts (Roboto from vfs_fonts.js); html-to-pdfmake options: imagesByReference, tableAutoSize; pageMargins 28.35pt; defaultStyle fontSize 9 (≈12px).'];
    let r;
    try {
      r = await attempt('as-is');
      notes.push('as-is conversion succeeded.');
    } catch (e) {
      notes.push(`as-is conversion FAILED: ${String(e.message ?? e).split('\n')[0].slice(0, 300)}`);
      r = await attempt('svg-workaround');
      notes.push('Workaround applied and succeeded (see log).');
    }
    notes.push(...r.log, `conversion (html-to-pdfmake) ${r.tConv.toFixed(0)} ms of ${r.ms.toFixed(0)} ms total`);
    await page.close();
    return { bytes: b64ToBuf(r.b64), ms: r.ms, timing: 'in-page htmlToPdfmake()+createPdf().getBuffer()', notes };
  },

  async pagedjs(browser, base) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}/research/compare/paged.html?preset=two-page`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
    await page.evaluate(() => document.fonts.ready);
    const r = await page.evaluate(async () => {
      const t0 = performance.now();
      const flow = await window.PagedPolyfill.preview();
      return { ms: performance.now() - t0, pages: flow?.total ?? document.querySelectorAll('.pagedjs_page').length };
    });
    const t1 = performance.now();
    const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    const pdfMs = performance.now() - t1;
    await page.close();
    return {
      bytes: Buffer.from(bytes),
      ms: r.ms + pdfMs,
      timing: 'in-page PagedPolyfill.preview() + Node-side page.pdf()',
      notes: [`Paged.js paginate ${r.ms.toFixed(0)} ms + page.pdf ${pdfMs.toFixed(0)} ms; Paged.js reported ${r.pages} pages`, ...errors.map((e) => `page error: ${e}`)],
    };
  },
};

// ---------- measurements ----------
async function fixtureTruth(browser, base) {
  const page = await openFixture(browser, base, 'preset=two-page');
  const t = await page.evaluate(() => ({
    grand: window.__fixture.grand,
    ids: window.__fixture.ids,
    rows: [...document.querySelectorAll('#invoice table.items tbody tr')].map((tr) => ({ id: tr.dataset.id, amount: tr.lastElementChild.textContent.trim() })),
  }));
  await page.close();
  return t;
}

const count = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);

function measureText(pages, truth) {
  // Collapse whitespace per page (some producers split strings into separate items).
  const pageTexts = pages.map((p) => p.items.map((i) => i.str).join(' ').replace(/\s+/g, ' '));
  const pageTextsTight = pages.map((p) => p.items.map((i) => i.str).join(''));
  const full = pageTexts.join('\n');
  const chars = full.replace(/\s/g, '').length;
  const idCounts = truth.ids.map((id) => count(full, id));
  const exactlyOnce = idCounts.filter((c) => c === 1).length;
  const positions = truth.ids.map((id) => full.indexOf(id));
  let inOrder = true;
  let prev = -1;
  for (const p of positions) {
    if (p < 0) continue;
    if (p < prev) inOrder = false;
    prev = p;
  }
  const grandCount = count(full, truth.grand);
  const grandCountTight = pageTextsTight.reduce((s, t) => s + count(t, truth.grand), 0);
  const idPage = (id) => pageTexts.findIndex((t) => t.includes(id));
  const pagesWithItems = [...new Set(truth.ids.map(idPage).filter((p) => p >= 0))].sort((a, b) => a - b);
  const headerOnPages = pagesWithItems.map((p) => ({ page: p + 1, unitPrice: pageTexts[p].includes('Unit price') }));
  // Row split detection (two independent signals):
  //  (a) a row's amount is missing from its id's page but present on the next page;
  //  (b) on a continuation page, body text sits ABOVE the first item id (excluding table-header words),
  //      i.e. the previous page's last row continues here.
  const splits = [];
  for (const row of truth.rows) {
    const p = idPage(row.id);
    if (p < 0) continue;
    const expectedOnPage = truth.rows.filter((r) => idPage(r.id) === p && r.amount === row.amount).length;
    if (count(pageTexts[p], row.amount) < expectedOnPage && p + 1 < pageTexts.length && pageTexts[p + 1].includes(row.amount)) splits.push(`${row.id} (p${p + 1}): amount ${row.amount} on p${p + 2}`);
  }
  const HEADER_WORDS = new Set(['ID', 'Description', 'Qty', 'Unit', 'price', 'Unit price', 'Disc.', 'Amount', '(NPR)', 'Amount (NPR)']);
  for (const q of pagesWithItems) {
    if (q === 0) continue;
    const idYs = pages[q].items.filter((i) => /ITEM-\d{4}/.test(i.str)).map((i) => i.y);
    const firstIdY = Math.min(...idYs);
    // Repeated header band: anything within 14pt below the "Description" header cell (covers wrapped/clipped header words).
    const hdr = pages[q].items.find((i) => i.str.trim() === 'Description' && i.y < firstIdY);
    const inHeader = (i) => HEADER_WORDS.has(i.str.trim()) || (hdr && i.y >= hdr.y - 1 && i.y <= hdr.y + 14);
    const above = pages[q].items.filter((i) => i.str.trim() && i.y < firstIdY - 2 && !inHeader(i));
    if (above.length) {
      const prevIds = pageTexts[q - 1].match(/ITEM-\d{4}/g) ?? [];
      splits.push(`${prevIds.at(-1) ?? '?'} (p${q}) continues on p${q + 1}: "${above.map((i) => i.str).join(' ').replace(/\s+/g, ' ').slice(0, 60)}"`);
    }
  }
  // Text placed (partly) outside the page box: clipped content.
  const offPage = [];
  pages.forEach((p, pi) => p.items.forEach((i) => {
    if (i.str.trim() && (i.x + i.w > p.width + 0.5 || i.x < -0.5)) offPage.push(`p${pi + 1}:"${i.str.slice(0, 20)}"`);
  }));
  return {
    textChars: chars,
    textExtractable: chars > 0,
    ids: { exactlyOnce, missing: idCounts.filter((c) => c === 0).length, duplicated: idCounts.filter((c) => c > 1).length, inOrder: exactlyOnce > 0 ? inOrder : null },
    grandTotal: { value: truth.grand, count: grandCount, countIgnoringSplits: grandCountTight, exactlyOnce: grandCount === 1 },
    headerRepeated: pagesWithItems.length ? headerOnPages.every((h) => h.unitPrice) : null,
    headerOnPages,
    rowSplits: chars > 0 ? splits : null,
    screenOnlyBannerLeaked: chars > 0 ? full.includes('SCREEN-ONLY') : null, // text-based; raster output checked by eye (see VISUAL)
    textBeyondPageEdge: chars > 0 ? { count: offPage.length, sample: offPage.slice(0, 6) } : null,
  };
}

// ---------- main ----------
const RUNS = +(process.env.RUNS ?? 5);
const { server, base } = await startServer();
const browser = await launch('chromium');
versions.chromium = browser.version();
const results = { generated: new Date().toISOString(), fixture: 'fixtures/invoice.html?preset=two-page (28 rows)', versions, tools: {} };
let nativeP1 = null;
try {
  const truth = await fixtureTruth(browser, base);
  const order = ['chromium-print', 'zedpdf', 'html2pdf', 'pdfmake', 'pagedjs'];
  for (const name of order) {
    const res = { ok: false };
    results.tools[name] = res;
    try {
      // RUNS fresh pages per tool; the first run includes script parse/JIT warm-up. Median is reported; bytes/analysis from the last run.
      const runs = [];
      let out;
      for (let k = 0; k < RUNS; k++) {
        out = await tools[name](browser, base);
        runs.push(+out.ms.toFixed(1));
      }
      const sorted = [...runs].sort((a, b) => a - b);
      Object.assign(res, { ok: true, ms: sorted[Math.floor(sorted.length / 2)], msRuns: runs, timing: out.timing, bytes: out.bytes.length, notes: out.notes });
      writeFileSync(new URL(`${name}.pdf`, outDir), out.bytes);
      try {
        const info = await inspect(out.bytes);
        Object.assign(res, {
          pages: info.mupdfPages,
          pageSizePt: [...new Set(info.sizes.map((s) => s.join('x')))],
          opensMuPDF: true,
          mupdfRepaired: info.mupdfRepaired,
          opensPdfjs: info.pdfjsPages > 0,
          pdfjsPages: info.pdfjsPages,
          xrefOk: info.xref.ok,
          xrefDetail: info.xref.ok ? undefined : info.xref.error ?? info.xref.errors,
        });
      } catch (e) {
        res.inspectError = String(e.message ?? e);
      }
      try {
        Object.assign(res, measureText(await extract(out.bytes), truth));
      } catch (e) {
        res.extractError = String(e.message ?? e);
      }
      try {
        const r = render(out.bytes, 96);
        writeFileSync(new URL(`${name}-p1.png`, outDir), r[0].png);
        res.p1Png = `samples/compare/${name}-p1.png`;
        // Font names referenced in the file (raw /BaseFont scan; none of these outputs use object streams).
        res.baseFonts = [...new Set(Buffer.from(out.bytes).toString('latin1').match(/\/BaseFont ?\/[A-Za-z0-9+_-]+/g) ?? [])].map((s) => s.replace(/\/BaseFont ?\//, ''));
        if (name === 'chromium-print') nativeP1 = r[0];
        else if (nativeP1) res.p1PixelDiffVsNativePct = +(diffImages(r[0], nativeP1).ratio * 100).toFixed(2);
      } catch (e) {
        res.renderError = String(e.message ?? e);
      }
    } catch (e) {
      res.error = String(e.stack ?? e).split('\n').slice(0, 4).join(' | ');
    }
    console.log(name, JSON.stringify({ ok: res.ok, ms: res.ms, pages: res.pages, bytes: res.bytes, error: res.error }));
  }
} finally {
  await browser.close();
  server.close();
}

// Written by a human/agent after looking at samples/compare/*-p1.png and all-page renders on 2026-11-25
// (Chromium 159, versions above). Re-check if versions change.
const VISUAL = {
  'chromium-print': 'Reference. Noto Sans, blue header row, zebra rows, rounded party boxes, PAID stamp as vector. p1 ends after ITEM-0013; p2 repeats the table header; p3 holds only the closing note.',
  zedpdf: 'Visually near-identical to native on p1 (same fonts, colors, page breaks: 13 rows on p1, repeated header on p2, note alone on p3). Sub-pixel text position drift (~1px). PAID stamp is rasterized (zedpdf info warning).',
  html2pdf: 'Whole page is a JPEG (no text layer, ~1 MB). Fonts/colors look like the screen render, BUT it captured screen media: the red "SCREEN-ONLY BANNER (hidden in print/export)" is visible, shifting everything ~30px down. Breaks rows cleanly (13 rows p1) but no repeated header on p2; 2 pages total.',
  pdfmake: 'Very different layout: class-based CSS is not applied (no flex header, no blue header row, no zebra, no rounded boxes; plain bordered tables). Roboto instead of Noto Sans. Logo rendered at natural size (huge). Product thumbnail rendered at natural size, pushing ITEM-0002 description to p2. Items table overflows the right margin: "Amount (NPR)" column is clipped off the page. Screen-only banner rendered (no CSS). Header row does repeat (after data-pdfmake headerRows workaround).',
  pagedjs: 'p1 visually matches native print (same fonts/colors/break). p2 has NO repeated table header (Paged.js splits the table into a new fragment without the thead), so the content fits on 2 pages and the closing note lands on p2 instead of p3.',
};

results.visualNotesManual = VISUAL;
writeFileSync(new URL('results.json', outDir), JSON.stringify(results, null, 2));

const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : v == null ? 'n/a' : String(v));
const rows = Object.entries(results.tools).map(([n, r]) =>
  r.ok
    ? `| ${n} | ${r.ms} | ${r.pages} | ${r.bytes} | ${yn(r.opensMuPDF)}${r.mupdfRepaired ? ' (repaired)' : ''} / ${yn(r.opensPdfjs)} | ${yn(r.xrefOk)} | ${yn(r.textExtractable)} | ${r.ids?.exactlyOnce ?? 'n/a'}/28${r.ids?.inOrder === false ? ' (out of order)' : ''} | ${r.grandTotal ? `${r.grandTotal.count}×` : 'n/a'} | ${yn(r.headerRepeated)} | ${r.rowSplits == null ? 'n/a (no text)' : r.rowSplits.length ? r.rowSplits.join('; ') : 'none detected'} | ${yn(r.screenOnlyBannerLeaked)} | ${r.textBeyondPageEdge ? r.textBeyondPageEdge.count : 'n/a'} | ${r.p1PixelDiffVsNativePct ?? '—'} |`
    : `| ${n} | FAILED: ${r.error} ||||||||||||`,
);
const md = `# HTML→PDF comparison on the invoice fixture

Fixture: \`${results.fixture}\` · generated ${results.generated}

Versions: ${Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(', ')}

| tool | ms (median) | pages | bytes | opens MuPDF / pdf.js | xref ok | text | ids once (in order) | grand total found | header on every item page | row split across pages | screen-only banner leaked | text items beyond page edge | p1 pixel diff vs native % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

ms runs (each in a fresh page): ${Object.entries(results.tools).map(([n, r]) => `${n} [${(r.msRuns ?? []).join(', ')}]`).join('; ')}.

Timing column: ${Object.entries(results.tools).map(([n, r]) => `${n} = ${r.timing ?? 'n/a'}`).join('; ')}.
Pixel diff is pixelmatch (threshold 0.15) of page 1 at 96 dpi vs native print page 1, cropped to the common size; it is a coarse layout-drift signal, not a quality score.

## Notes per tool (measured/logged by the script)
${Object.entries(results.tools).map(([n, r]) => `- **${n}**: ${(r.notes ?? []).join(' ')} Fonts referenced: ${(r.baseFonts ?? []).join(', ') || 'n/a'}.${r.rowSplits?.length ? ` Row splits: ${r.rowSplits.join('; ')}.` : ''}${r.textBeyondPageEdge?.count ? ` Text beyond page edge e.g. ${r.textBeyondPageEdge.sample.join(' ')}.` : ''}${r.error ? ` ERROR: ${r.error}` : ''}`).join('\n')}

## Visual fidelity vs native print (manual observation of the PNGs, NOT computed)
${Object.entries(VISUAL).map(([n, v]) => `- **${n}**: ${v}`).join('\n')}
`;
writeFileSync(new URL('results.md', outDir), md);
console.log(md);
