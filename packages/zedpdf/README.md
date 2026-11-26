# zedpdf

Turn an on-screen HTML element, such as an invoice, quotation, purchase order or report, into a real PDF **in the browser**. You get selectable, searchable text, vector boxes and borders, embedded fonts, sharp images, and page breaks that respect table rows, line boxes and `break-*` rules.

- **Zero runtime dependencies.** No server, no headless browser, no CDN, no print dialog.
- **Reuses the browser's own layout.** The element is laid out once at the printable width in an offscreen iframe. Every word's position is measured, then written as real PDF text at that exact position.
- **Close to native print.** On the reference invoice fixture, text positions match Chromium's print-to-PDF within 0.35 pt, and pixel difference is ≤ 0.17 % per page (see *Fidelity* below).
- **Honest about gaps.** Anything it cannot reproduce comes back as a structured warning with the element and a remedy. `strict: true` turns those warnings into a failure.

**[Documentation & live demo](https://pushpa1105.github.io/zed-pdf/)** · [API docs](https://pushpa1105.github.io/zed-pdf/docs.html) · [Changelog](https://pushpa1105.github.io/zed-pdf/changelog.html) · [Issues](https://github.com/pushpa1105/zed-pdf/issues)

```sh
npm install zedpdf
```

## Quick start

```js
import { pdf } from 'zedpdf';

const invoice = pdf('#invoice', {   // an element or a selector
  format: 'A4',                     // 'A4' | 'Letter' | 'A3' | 'A5' | 'Legal' | { width, height }
  margin: '12mm',                   // one length, or { top, right, bottom, left }
  title: 'Invoice INV-2026-0042',
  filename: 'INV-2026-0042',
});

await invoice.download();           // save INV-2026-0042.pdf
await invoice.print();              // the browser's print dialog, just this element
await invoice.open();               // open it in a new tab (popup-blocker safe)
await invoice.preview('#viewer');   // show it inside your page
await invoice.share();              // share sheet on phones, download elsewhere
const file = await invoice.file();  // a File for uploads (FormData)
const result = await invoice.render(); // blob, pageCount, warnings + all of the above
```

Each call takes a fresh snapshot of the element.

### Plain HTML: buttons with no JavaScript

```html
<script src="zedpdf.global.js"></script>

<button data-zedpdf="download" data-zedpdf-target="#invoice" data-zedpdf-filename="INV-42">Download</button>
<button data-zedpdf="print"    data-zedpdf-target="#invoice">Print</button>
<button data-zedpdf="open"     data-zedpdf-target="#invoice">Open</button>
<button data-zedpdf="preview"  data-zedpdf-target="#invoice" data-zedpdf-preview="#viewer">Preview</button>
<button data-zedpdf="share"    data-zedpdf-target="#invoice">Share</button>
```

- **Options as attributes:** `data-zedpdf-format`, `-orientation`, `-margin`, `-title`, `-media`, `-css`, `-strict`, `-complex-scripts`, or `data-zedpdf-options='{…json…}'`.
- **While working:** buttons get `aria-busy="true"` and are disabled.
- **When finished:** they fire bubbling `zedpdf:done` / `zedpdf:error` events with `detail.action` and `detail.result` or `detail.error`.
- **Binding:** the script-tag build (`window.ZedPdf`) binds buttons automatically. With the ES module, call `bindActions()` once.

### Vue 3 (template ref)

```vue
<script setup>
import { ref } from 'vue';
import { pdf } from 'zedpdf';
const invoice = ref(null);           // for a component ref, pass invoice.value.$el
const doc = () => pdf(invoice.value, { format: 'A4', filename: 'invoice' });
</script>
<template>
  <button @click="doc().download()">Download PDF</button>
  <button @click="doc().print()">Print</button>
  <div ref="invoice"><InvoiceDoc /></div>
</template>
```

Scoped styles (`[data-v-…]`) work unchanged.

### React (`useRef`)

```jsx
import { useRef } from 'react';
import { pdf } from 'zedpdf';

function InvoicePage() {
  const ref = useRef(null);
  const doc = () => pdf(ref.current, { format: 'Letter', filename: 'invoice' });
  return (
    <>
      <button onClick={() => doc().download()}>Download PDF</button>
      <button onClick={() => doc().open()}>Open</button>
      <article ref={ref}>…</article>
    </>
  );
}
```

Themes inherited from an ancestor also work: classes, CSS custom properties and fonts.

There are no framework wrappers. A template ref or `useRef` already hands you the `HTMLElement` that zedpdf takes.

## API

### `pdf(target, options?)`

Returns a handle with these methods; each accepts per-call options as its last argument:

| Method | Description |
|---|---|
| `download(name?)` | Save the PDF |
| `print()` | Native print dialog for the element |
| `open()` | New tab (opened inside the click, so popups are allowed); downloads if blocked |
| `preview(where)` | Show in an `<iframe>`, or in a container that gets one; replaces and releases the previous PDF |
| `share(data?)` | Web Share API with the file where supported; resolves `'shared'`, `'cancelled'` or `'downloaded'` |
| `file(name?)` / `blob()` | The PDF as a `File` or `Blob` |
| `render()` | The full result (below) |

### `bindActions(root = document) → unbind`

Binds `data-zedpdf` buttons inside `root`.

### Result object (`PdfFile`)

`exportPdf()` and `render()` resolve to `{ blob, pageCount, warnings, timings, filename }` plus `download()`, `open()`, `preview()`, `share()`, `file()`, `url()` and `dispose()`. Export once, then reuse the file several ways.

### `exportPdf(element, options?) → Promise<PdfFile>`

The lower-level function behind `pdf()`. It resolves to the same result object.

| Option | Default | Meaning |
|---|---|---|
| `format` | `'A4'` | `'A4' \| 'Letter' \| 'A3' \| 'A5' \| 'Legal'` or `{ width, height }` (lengths) |
| `orientation` | `'portrait'` | `'portrait' \| 'landscape'` |
| `margin` | `'10mm'` | A length (`12`, `'12mm'`, `'0.5in'`, `'36pt'`), or per side |
| `css` | – | Extra CSS applied **only** to the export (the export-only hook) |
| `media` | `'print'` | `'print'` applies `@media print` rules and disables `@media screen` rules. `'screen'` keeps the screen cascade |
| `fonts` | – | `[{ family, weight?, style?, src: URL \| ArrayBuffer \| Blob }]`: font bytes to embed (TTF/OTF/WOFF) |
| `assetResolver` | – | `(url, 'image' \| 'font') => bytes \| null`: supply asset bytes yourself (auth, caches) |
| `assetTimeout` | `10000` | ms to wait for each stylesheet, font and image |
| `header` / `footer` | – | `{ html }` repeated on every page. Elements with class `pageNumber` / `totalPages` get the numbers |
| `repeatTableHeader` | `true` | Repeat `<thead>` on every page a table spans |
| `keepHeadingsWithNext` | `false` | Treat `h1`–`h6` as `break-after: avoid` |
| `oversizedImage` | `'scale'` | An image taller than a page: `'scale'` it to fit, or `'slice'` it across pages |
| `complexScriptFallback` | `'none'` | Complex scripts (Devanagari, Arabic, Thai, …): `'raster'` draws browser-shaped words as images plus an invisible text layer |
| `rasterScale` | `3` | Device scale for rasterized content (SVG, canvas, complex-script words) |
| `maxImageDpi` | `300` | Downsample images whose source is larger than needed for their printed size; `false` keeps originals |
| `jpegQuality` | `0.85` | JPEG quality used only when a downsampled photo is re-encoded |
| `expandScrollContainers` | `true` | Export the full content of scrollable areas |
| `strict` | `false` | Reject with `ZedPdfError('fidelity')` if any warning with severity `'warning'` occurs |
| `signal` | – | `AbortSignal`. Rejects with `ZedPdfError('aborted')` and always removes the export surface |
| `title`, `author`, `subject` | – | PDF metadata |
| `filename` | from title | File name for `download`, `share`, `file` (`.pdf` is added) |
| `onProgress` | – | `(stage, {page, pages}?) => void` |

`ExportWarning = { code, severity: 'info' | 'warning' | 'error', message, element?, remedy?, count }`

Common codes:
- `font-substituted`: no font bytes were available, so a standard PDF font is used and positions still match.
- `asset-unavailable`
- `complex-script-unshaped`
- `transform-unsupported`, `filter-unsupported`, `background-image-unsupported`, `fixed-element`
- `rowspan-split`, `table-header-not-repeated`, `oversized-image-scaled`, `monolithic-sliced`
- `missing-glyph`
- `horizontal-overflow`

### `printElement(element, options?) → Promise<void>`

Opens the browser's print dialog for just this element. The element is cloned with its full styling context into a hidden iframe, and the browser's own print cascade applies: `@media print`, `@page` and `break-*`. Options: `format`, `orientation`, `margin`, `css`, `title`, `applyPageRule` (default `true` emits `@page { size; margin }`), `assetTimeout`, `signal`. The promise resolves after the dialog closes.

### `savePdf(blob, filename?)`

Triggers a download and revokes the object URL.

## How exports are styled

- **Direct path (`exportPdf`).** An iframe is a *screen* media context. zedpdf copies your stylesheets into it and, with `media: 'print'` (the default), rewrites media queries:
  - `print` and `all` become `all`.
  - Other media types (such as `screen`) become `not all`.
  - Feature queries such as `(min-width)` evaluate against the printable width, just like print.
  - Add export-only rules with `options.css`. The export root `<html>` also carries the class `zedpdf-export`.
- **Native path (`printElement`).** The browser's real print cascade applies unchanged.

## What is supported (first release)

- **Layout.** Normal block flow, flex and grid (as measured), multi-column text (in reading order), floats and absolutely positioned boxes (painted where the browser placed them).
- **Text.** Common inline styles: font family, weight and style, size, color, letter-spacing, `text-transform`, underline/line-through, `<br>`, `<sup>`/`<sub>`, justified text, `pre` whitespace.
- **Boxes.** Padding and margins, solid, dashed, dotted and double borders, `border-radius`, CSS triangles, solid backgrounds with alpha, `opacity`, `overflow` clipping, outer `box-shadow` (approximated).
- **Tables.** Semantic tables (`thead` repeated, `tfoot` rendered once), captions, **nested tables** (paginated inside their cell with their own header repeated), `colspan`, and `rowspan` (groups kept together when they fit).
- **Images.**
  - PNG (transparency preserved) and JPEG (bytes embedded unchanged when they are not oversized).
  - Images larger than needed are downsampled to `maxImageDpi` (default 300).
  - SVG, WebP, GIF and `<canvas>` charts are rasterized.
  - Responsive images (`srcset`) and `object-fit` work.
  - Identical images and icons are embedded once.
- **Links.** `<a href>` with `http(s):`, `mailto:` or `tel:` becomes a clickable link.
- **Generated content.** `::before`/`::after` text, list bullets and numbers, `details`/`summary` (closed content stays hidden, disclosure triangles drawn).
- **Form controls.** Box plus value; checkboxes, radios and select chevrons drawn as vector shapes.

## File size

A typical two-page invoice is about 50 KB, smaller than Chromium's own print-to-PDF (72 KB) for the same page:

- Fonts are subset to the glyphs used and renumbered compactly.
- Images are sized for print (`maxImageDpi`, default 300). Oversized photos are re-encoded as JPEG (`jpegQuality`, default 0.85); already-suitable JPEGs are kept byte for byte.
- Lossless images use PNG row filters. Complex-script word images are stored as a single-colour mask.
- Drawing instructions only restate colours, fonts and alpha when they change.

| Document | zedpdf | Chromium print |
|---|---|---|
| Two-page invoice (logo, photo, 28 rows) | 49 KB | 72 KB |
| 1,000-row invoice (49 pages) | 221 KB | 283 KB |
| Nepali/English invoice (raster fallback) | 82 KB | 77 KB |

Not yet supported (each is reported as a warning):

- Rotations, scales and skews, filters, `clip-path` and blend modes. Translations are fine.
- CSS background images and gradients.
- `text-shadow`.
- Vertical writing modes, and bidi text without the raster fallback.
- WOFF2 fonts (supply TTF/OTF/WOFF instead).
- Shadow DOM content.
- Virtualized lists: only rendered rows exist in the DOM.
- In-page `#anchor` links and tagged (accessible) PDF structure.

## Pagination rules

- **Model.** One page model (paper − margins − header/footer) drives everything; 1 CSS px = 0.75 pt, with fractional precision kept until the bytes are written.
- **Break opportunities.** Between blocks, between table rows, and between measured line boxes. Forced `break-before`/`break-after: page` apply first.
- **Unforced breaks.** These honor `break-inside: avoid`, `break-before`/`break-after: avoid`, `orphans` and `widows` (default 2). When no break satisfies every rule, they are relaxed in CSS Fragmentation §4.4 order: orphans/widows first, then the avoid rules.
- **Rows.**
  - A row stays intact whenever it fits on a fresh page. An exact fit stays on the current page.
  - Space for the repeated `thead` is reserved first, and a header is never left alone at the bottom of a page.
  - A row taller than a page splits at line boundaries, each cell tracking its own progress. Amounts and images are painted once, and the next row starts only after every cell has finished.
- **Columns.** Widths, alignment and borders never drift between pages, because every page reuses the same measured layout.
- **Totals.** `tfoot` (e.g. invoice totals) is rendered once. Put `break-inside: avoid` on a totals block to keep subtotal, tax and grand total together.
- **Last resort.**
  - Content that cannot fit any page is scaled (images) or sliced, with a diagnostic.
  - A header taller than ¼ page is not repeated (CSS Tables §6.2), with a diagnostic.
  - Every page consumes content; a stalled paginator raises `pagination-failed` rather than looping.

## Fonts

To embed a font, zedpdf needs its bytes. A CSS family name alone does not give access to them. It takes bytes from `options.fonts`, or from `@font-face` `src` URLs (TTF/OTF/WOFF) found in your stylesheets.

- **Embedding.** Fonts are subset and embedded as CIDFontType2 with a ToUnicode map, so copy/paste and search work, and each face is embedded once.
- **Fallback.** Text whose font has no available bytes falls back to the PDF standard fonts (Helvetica, Times, Courier; Latin-1 only), with a `font-substituted` warning.
- **Missing glyphs.** Characters that no font covers are reported as `missing-glyph`. They are never silently replaced.

## Complex scripts

Devanagari conjuncts, Arabic joining and similar need OpenType shaping, which the vector text path does not implement yet.

- **Default.** Text **extracts correctly** (logical Unicode order), but glyphs are drawn unshaped and a `complex-script-unshaped` warning is raised.
- **`complexScriptFallback: 'raster'`.** Each affected word is drawn by the browser (correctly shaped) at 288 dpi, with an invisible text layer on top, so the text stays selectable and searchable.
- **`printElement()`.** The browser's print engine shapes the text natively.

## Fidelity

These figures come from the repository's verification suite. Fixture: a two-page invoice with an embedded Noto Sans font, a transparent PNG logo, wrapped descriptions, a repeated header and totals. It was compared with Chromium 159 print-to-PDF at matched paper and margins.

- Same page breaks.
- All 28 item IDs on the same page at **dx = 0.00 pt**, |dy| ≤ 0.35 pt.
- Pixel diff 0.17 % / 0.13 % / 0 % at 96 dpi.

Exporting the same fixture with exact A4 and 10 mm margins differs only because Chromium's print pipeline rounds paper to 595.92 × 841.92 pt and margins to whole CSS px.

## Browser support

The full suite runs on Playwright's Chromium 159; a Firefox 159 / WebKit 27.2 subset is covered by the compatibility report.

Requirements: `CompressionStream` / `DecompressionStream` (Chrome 80, Firefox 113, Safari 16.4). See `docs/support-matrix.md` in the repository for what was verified per engine.

## License

MIT.
