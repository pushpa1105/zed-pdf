# Support matrix and compatibility guide

All browser runs use the Playwright 1.65.1 builds on Windows 11 (AMD Ryzen 7 5800H, 16 GB):
- **Chromium** 159.0.8154.6
- **Firefox** 159.0
- **WebKit** 27.2

These are the engines inside Chrome/Edge, Firefox and Safari, but they are not branded release builds. Safari on macOS/iOS, and any mobile browser, are **unverified**.

Legend:
- ✅ verified by an automated test or report in this repo
- 🟡 works, but is approximated or only partly verified
- ⚠️ reported as a warning (fidelity loss)
- ❌ not supported (warning)
- ❔ not verified

## Engines

| Scenario | Chromium | Firefox | WebKit | Evidence |
|---|---|---|---|---|
| Two-page invoice: valid PDF, text order, total once, no fidelity warnings | ✅ | ✅ | ✅ | `tests/invoice.spec.mjs` (`@compat`), `samples/compat/report.json` |
| 200-row invoice: all IDs once and in order, 11 pages | ✅ | ✅ | ✅ | `samples/compat/report.json` |
| Oversized row, missing image, bilingual raster presets | ✅ | ✅ | ✅ | `samples/compat/report.json` |
| Full e2e suite: boundaries, geometry, context, cancellation, strict, demo | ✅ | ❔ | ❔ | `tests/*.spec.mjs` (28 tests, Chromium project) |
| Pixel/position comparison with the engine's native print | ✅ (Chromium print-to-PDF) | ❔ | ❔ | Playwright can only print to PDF in Chromium |
| `printElement()` opens print on a styled clone and cleans up | ✅ (print() intercepted) | ❔ | ❔ | `tests/context.spec.mjs`; the real dialog was not automated |
| 1,000 rows, 49 pages | ✅ 0.86 s | ✅ 0.87 s | ✅ 2.4 s | `samples/bench.json` (median of 5) |

Observed but unverified: in WebKit, a few inter-word gaps render slightly tighter than in Chromium/Firefox (e.g. "Galvanised,5"). Text order and extraction are correct. It has not been compared against WebKit's own print output.

Required APIs:
- `CompressionStream` / `DecompressionStream('deflate')`: Chrome 80, Firefox 113, Safari 16.4.
- `Range.getClientRects`.
- `document.fonts`.
- A same-origin `about:blank` iframe.

## Layout and CSS

| Feature | Status | Notes |
|---|---|---|
| Block flow, margins, padding | ✅ | measured geometry |
| Flex / grid rows (invoice header, party boxes) | ✅ | measured; overlapping siblings fragment as parallel columns |
| Floats, absolutely positioned children | 🟡 | painted where laid out; fragment as parallel columns |
| `position: fixed` | ⚠️ | drawn once (native print repeats it); use `header`/`footer` |
| Solid backgrounds with alpha, `opacity` | ✅ / 🟡 | group opacity is approximated per element |
| Borders: solid, dashed, dotted, double, `border-radius` | ✅ / 🟡 | non-uniform borders with radius ignore the radius |
| Outer `box-shadow` | 🟡 | layered approximation of blur; inset is ⚠️ |
| `overflow` clipping | ✅ | including rounded clips |
| Background images, gradients | ⚠️ | colour only; use `<img>` |
| Transforms | ✅ translate / ⚠️ other | |
| `filter`, `clip-path`, blend modes, `text-shadow` | ⚠️ | |
| `::before` / `::after` text, list markers | ✅ / 🟡 | counters ⚠️; markers are approximated glyphs |
| Form controls | 🟡 | box + value; checkbox, radio and select chevron drawn as vector shapes |
| Scroll containers | ✅ | expanded by default (`expandScrollContainers`) |
| Virtualized tables | ❌ | only rendered rows exist; render all rows for export |
| Shadow DOM | ⚠️ | not cloned |
| Nested tables (incl. inside a row taller than a page) | ✅ | `tests/webapp.spec.mjs` |
| Multi-column text and lists | ✅ | read column by column |
| `details`/`summary`, `pre`, `dl`, nested lists, `kbd`/`mark`/`del`/`ins` | ✅ | `tests/webapp.spec.mjs` |
| Links (`http(s)`, `mailto`, `tel`) | ✅ | clickable annotations; in-page `#anchor` links ❌ |
| Canvas charts, repeated inline SVG icons | ✅ / 🟡 | rasterized; identical icons stored once |
| `@media print` on the direct path | ✅ | `tests/context.spec.mjs` |
| Vue scoped CSS, ancestor theme with CSS variables | ✅ | context tests and real Vue/React consumer apps |
| `@page` rules on the direct path | ❔ | page size and margins come from options |

## Text and fonts

| Feature | Status | Notes |
|---|---|---|
| TrueType/OpenType (glyf) embedding with subset and ToUnicode | ✅ | copy/paste and search |
| CFF-based OpenType | 🟡 | embedded whole (FontFile3); not covered by fixtures |
| WOFF 1.0 | 🟡 | decoded with DecompressionStream; no fixture |
| WOFF2 | ❌ | warning `font-woff2-unsupported`; supply TTF/OTF/WOFF |
| System fonts (no bytes) | ⚠️ | Core-14 fallback; positions still match the layout |
| Bold, italic, currency symbols (€ £ ₹ −), punctuation | ✅ | |
| Synthetic bold/italic when a face is missing | 🟡 | stroke and skew, like browsers |
| `letter-spacing`, justify, `text-transform`, underline/strike | ✅ | |
| Devanagari / Arabic / Thai: extraction | ✅ (Devanagari tested) | logical order via ToUnicode |
| Devanagari / Arabic / Thai: visual shaping | ⚠️ default / ✅ with `complexScriptFallback: 'raster'` | raster words plus invisible text layer |
| RTL / bidi | ⚠️ | measured word order; use the raster fallback or `printElement` |
| Hyphenation (`hyphens: auto`) | ❔ | the inserted hyphen glyph is not in the DOM |

## Pagination

All rows below are ✅, verified in `tests/pagination.spec.mjs` and `test/paginate.test.ts`:

- Exact-fit row stays.
- Row 0.5 px over moves.
- Full-page row.
- Multi-page row with per-cell progress.
- Repeated header with space reserved.
- Header never alone at the bottom of a page.
- `tfoot` / totals rendered once.
- Keep-together totals; an oversized totals block splits with a diagnostic.
- `colspan`.
- `rowspan` group moved intact.
- Header > ¼ page not repeated.
- Oversized image scaled or sliced.
- Forced breaks.
- `break-after: avoid`.
- Orphans and widows.
- No blank leading or trailing pages.
- Stall detection.

A `rowspan` group taller than a page is split with a `rowspan-split` warning. Strict mode rejects it before the PDF is written.

## Images

PNG (alpha via SMask; passthrough without alpha) ✅ · images larger than needed downsampled to `maxImageDpi` (default 300) ✅ · JPEG (bytes unchanged; EXIF-rotated JPEGs are rasterized) ✅ · repeated image embedded once ✅ · `object-fit`/`object-position` ✅ · SVG / WebP / GIF / canvas 🟡 rasterized · missing or unreadable image ✅ warning with element path · `assetResolver` ✅.
