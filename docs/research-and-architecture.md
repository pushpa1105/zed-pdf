# zedpdf: research and architecture note

**Goal:** turn an on-screen `HTMLElement` into a PDF in an ordinary browser tab that closely matches the browser's own print output. Text must stay selectable, images sharp, and long tables must paginate cleanly. No server, no runtime dependencies.

Sources are split in two:
- **Documentation-derived** findings, with links: [research-sources.md](research-sources.md).
- **Reproduced** findings, measured in this repository: listed below with the command that produced them.

## 1. What we learned

### From documentation (not reproduced by us)
- **CSS Fragmentation 3 §4.4 defines the break rules and the order in which they are relaxed.** Orphans/widows go first, then avoid rules, then monolithic content is sliced. Every page must hold some content. zedpdf implements this order itself, because engines differ:
  - Firefox does not support `widows`/`orphans`.
  - WebKit does not repeat `thead` when printing (bug 17205).
- **CSS Tables 3 §6:** rows that fit stay intact; oversized rows break with cells fragmenting independently; headers repeat only if ≤ ¼ page.
- **CSS Paged Media §3:** the page area is the initial containing block. So we lay out at the page content width.
- **CSSOM View:** `Range.getClientRects()` returns one rect per line fragment of the selected text, sized from font ascent and descent rather than `line-height`.
- **ISO 32000-1:**
  - `Tw` does not apply to 2-byte codes (§9.3.3).
  - Identity-H text is not extractable without a ToUnicode CMap (§9.10).
  - A CIDFontType2 program must not contain a `cmap` (§9.9).
  - xref entries are exactly 20 bytes (§7.5.4).
  - PNG IDAT can be passed through with Flate `/Predictor 15` (§7.4.4.4).
- **Competitors** (per their docs):
  - html2pdf.js produces an image-only PDF.
  - pdfmake needs a document definition, not HTML.
  - Paged.js paginates in the DOM and relies on `window.print()`.

### Reproduced
**1. Feasibility experiment (Milestone 1)** — `node scripts/m1-experiment.mjs`, output in `samples/m1/`.
- Fixture: a 28-row invoice with embedded Noto Sans (TTF via `@font-face`), a transparent PNG logo, a JPEG thumbnail, an SVG stamp, wrapped descriptions, `<br>` and mixed inline styles, `thead`, and a totals block.
- zedpdf and Chromium 159 print-to-PDF (`page.pdf`, no header/footer, background on) each produce **3 pages with identical breaks**.
- Both files open in MuPDF without repair and in pdf.js; our strict xref check passes.

**2. Chromium print quantizes the requested geometry.**
- Paper: 210 × 297 mm becomes 595.92 × 841.92 pt (exact A4 is 595.28 × 841.89).
- Margins: 10 mm becomes 37 CSS px (27.75 pt).
- With the export set to the same geometry:
  - all 28 IDs and amounts sit at **dx = 0.00 pt** and |dy| ≤ 0.35 pt;
  - the pixel diff at 96 dpi is **0.17 % / 0.13 % / 0 %** per page.
- At exact A4 / 10 mm, the drift is ≤ 0.9 pt and comes entirely from that quantization. This is also the source of the 3.04 % page-1 diff in the competitor table below.

**3. Competitor run on the same invoice** — `cd research/compare && npm install && node run.mjs`. Full table in `samples/compare/results.md`; versions html2pdf.js 0.14.0, pdfmake 0.3.15 + html-to-pdfmake 2.6.0, Paged.js 0.4.3.

| | text extractable | 28 IDs once, in order | header on every page | rows split | fidelity vs print (observed) |
|---|---|---|---|---|---|
| Chromium print | yes | yes | yes | no | reference |
| **zedpdf** | yes | yes | yes | no | near-identical; same breaks |
| html2pdf.js | **no** (one JPEG per page, 1.05 MB) | 0/28 | n/a | no | captured *screen* media (screen-only banner leaked) |
| pdfmake + html-to-pdfmake | yes | yes | only after a manual `headerRows` workaround | **2 rows split** | CSS classes not applied; 33 items beyond the right edge; failed on the SVG `<img>` until it was replaced |
| Paged.js + print | yes | yes | **no** (header missing on p2) | no | p1 matches; different page count |

**4. Devanagari** — `tests/bilingual.spec.mjs`.
- **Extraction** of zedpdf output is exact in MuPDF in both modes: "बिल गर्ने ठेगाना", "श्रीमती सीता गुरुङ".
- Chromium's own print PDF of the same page extracts with duplicated vowel signs: "श्रीीमती", "क्षेेत्रीीय".
- pdf.js shifts spaces around zero-width combining marks in both files. This is an extractor heuristic, not missing text.
- **Shaping:** the vector path draws unshaped glyphs, so the i-matra is not reordered and halants are visible. The opt-in raster fallback is visually correct. Crops of both are in `samples/pdfs/invoice-bilingual-*-p1.png`.

**5. Range geometry is cheap enough to measure every word.**
- One `getClientRects`/`getBoundingClientRect` per word, with no per-character or per-page relayout.
- The 1,000-row invoice measures in ≈ 0.3 s in Chromium (`samples/bench.json`).

### Decision
Reuse the browser's layout, measure it once, paginate the measured geometry, and write a vector PDF ourselves. Screenshots lose text and exceed canvas limits. A document-definition approach loses the CSS. Paged.js still ends in `window.print()`, which offers no Blob and no headless path.

## 2. Architecture

```
HTMLElement
  │ 1. Surface (layout/surface.ts)
  │    offscreen same-origin iframe, viewport = page content width (× content height for vh)
  │    deep clone + ancestor wrappers (same tag/attrs) + html/body attrs → selectors, themes, CSS vars
  │    stylesheets serialized (url()s absolutized); media 'print': @media print→all, screen→not all
  │    ::before/::after and list markers materialized as spans; inputs/canvas/scroll state copied
  │    bounded waits: stylesheets, document.fonts.ready, img decode
  │ 2. Measure (layout/walk.ts)
  │    boxes: getBoundingClientRect / getClientRects (inline fragments) + computed style
  │    text: one Range per word → line runs grouped by measured top; baseline from one probe per font
  │    tree: block | line | leaf (monolithic) | parallel (overlapping siblings: flex rows, floats) | table/row/cell
  │ 3. Assets (font/fonts.ts, image/images.ts)
  │    font bytes: options.fonts → @font-face src (TTF/OTF/WOFF) → Core-14 fallback (warned)
  │    images: JPEG passthrough, PNG passthrough or RGB+SMask, others rasterized; deduplicated
  │ 4. Paginate (paginate/paginate.ts): pure, unit-tested
  │    break tokens; forced → fits → avoid/orphans/widows with §4.4 relaxation; rows/cells/columns
  │    output: per-page ops = measured geometry + per-fragment dy (no relayout ⇒ no column drift)
  │ 5. Render + write (render/render.ts, pdf/writer.ts)
  │    CTM maps CSS px→pt; boxes as paths; text as Type0/Identity-H with TJ per-word positioning
  │    + per-run Tz; text state isolated with q/Q; shared resources; byte-accurate xref
  ▼
{ blob, pageCount, warnings, timings }
```

Key choices and why:

- **One continuous layout, translated per fragment.** Column widths, alignment and borders can never drift between pages. A split row tracks one token per cell, so an amount or image is painted exactly once.
- **Word-level positioning.** Each word starts exactly where the browser put it. A small per-run `Tz` absorbs kerning and hinting differences. This also makes justified text, letter-spacing and mixed inline styles work without a text-layout engine.
- **Real text.** Subset TrueType fonts are embedded with stable glyph IDs, `/W` widths and ToUnicode. A space glyph is drawn between words so copy/paste is faithful.
- **Print cascade on the direct path.** An iframe is screen media, so media queries are rewritten deliberately and documented. `printElement()` uses the real print cascade.
- **Diagnostics instead of silence.** Every unsupported feature and every relaxed rule becomes a warning with the element path and a remedy. `strict` rejects before the PDF is written.

## 3. Limits that are known and measured
See [support-matrix.md](support-matrix.md). The main gaps:
- OpenType shaping for complex scripts (raster fallback available).
- WOFF2.
- CSS background images and gradients.
- Non-translate transforms.
- Shadow DOM.
- Byte-identical output: `/ID` and `CreationDate` vary between runs.
