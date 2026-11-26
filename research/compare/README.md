# HTML→PDF comparison (research only)

Compares html2pdf.js, pdfmake (+html-to-pdfmake), Paged.js (+Chromium print), zedpdf and native Chromium
print on the same fixture: `fixtures/invoice.html?preset=two-page` (28 item rows, local Noto Sans fonts).

This folder has its own `package.json` and is **not** part of the pnpm workspace, so none of these tools
become dependencies of the library. Nothing under `packages/`, `fixtures/` or `scripts/lib/` is modified.

## Run

```sh
# once, from the repo root: root deps (Playwright browsers, mupdf, pdfjs-dist) and the zedpdf build
pnpm install
pnpm build

# competitors, pinned to exact versions
cd research/compare
npm install
node run.mjs            # RUNS=5 by default (timing median); e.g. RUNS=1 node run.mjs
```

Outputs go to `samples/compare/`: `<tool>.pdf`, `<tool>-p1.png` (page 1, 96 dpi, MuPDF), `results.json`,
`results.md`. After `npm install` the run is offline (everything is served from the repo by
`scripts/serve.mjs`).

## How each tool is driven

- **chromium-print**: `nativePrint(page, {format:'A4', margin:'10mm'})` from `scripts/lib/browser.mjs`.
- **zedpdf**: `exportInPage(page, '#invoice', {format:'A4', margin:'10mm'})`.
- **html2pdf.js**: `dist/html2pdf.bundle.min.js` injected with `page.addScriptTag`; options A4, margin 10 mm,
  `pagebreak: {mode: ['css','legacy']}`, `html2canvas: {scale: 2}`; bytes via `outputPdf('arraybuffer')`.
- **pdfmake**: `pdfmake.min.js` + `vfs_fonts.js` (default Roboto) + `html-to-pdfmake/browser.js` injected;
  a clone of `#invoice` is converted with `{imagesByReference: true, tableAutoSize: true}`, A4, 28.35 pt margins.
  Workarounds (logged in results): `data-pdfmake='{"headerRows":1}'` on the items table (html-to-pdfmake does not
  turn `<thead>` into `headerRows`), and the SVG `<img>` (PAID stamp) replaced by inline `<svg>` because pdfmake
  rejects it as "Unknown image format". The script first tries without the SVG workaround and records the failure.
- **Paged.js**: `paged.html` here is a copy of the fixture page plus `@page { size: A4; margin: 10mm }` and
  `paged.polyfill.js` (`PagedConfig.auto = false`, then `PagedPolyfill.preview()` once the invoice is rendered),
  then `page.pdf({preferCSSPageSize: true, printBackground: true})`.

## Caveats

- Timings are not identical in scope: in-page for zedpdf/html2pdf/pdfmake (script load excluded);
  Node-side `page.pdf()` round trip for native print; Paged.js = in-page paginate + Node-side `page.pdf()`.
- Text checks use pdf.js extraction; a raster-only PDF (html2pdf) scores 0 on them by construction.
- Row-split detection is heuristic (amount on the next page, or body text above the first ID on a continuation page).
- The "Visual fidelity" section of `results.md` is a manual observation hard-coded in `run.mjs` (`VISUAL`);
  re-check it when versions change.
