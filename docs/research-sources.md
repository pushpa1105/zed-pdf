# Research sources (documentation-derived)

Everything in this file was read from the cited documents. It has not been reproduced by us.
Reproduced findings are in [research-and-architecture.md](research-and-architecture.md).

## CSS Fragmentation Level 3 — https://www.w3.org/TR/css-break-3/

- **Break properties** (§3.1–3.2)
  - `break-before` / `break-after`: `auto | avoid | avoid-page | page | left | right | recto | verso | …column/region`.
  - `break-inside`: `auto | avoid | avoid-page | …`.
- **orphans / widows** (§3.3, #propdef-orphans)
  - Inherited. Initial value is 2.
  - They count line boxes of a block container on each side of a break.
- **Break classes** (§4.1, #possible-breaks)
  - Class A: between sibling blocks, including between table rows.
  - Class B: between line boxes.
  - Class C: between a parent's content edge and its children.
- **Forced breaks** (§4.3): a forced break overrides `avoid` at the same break point.
- **Rules for unforced breaks** (§4.4, #unforced-breaks)
  - Rule 1: `break-before` / `break-after` avoid.
  - Rule 2: ancestor `break-inside: avoid` blocks Class A breaks.
  - Rule 3: orphans/widows.
  - Rule 4: `break-inside` on ancestors blocks Class B/C breaks.
- **Relaxation order** (§4.4)
  1. Drop Rule 3 first.
  2. Then drop Rules 1, 2 and 4.
  3. As a last resort, slice monolithic content. The UA "must place at least some content on each fragmentainer".
- **Monolithic content** (§4.1): replaced elements and scroll containers may be treated as monolithic. Slicing them is allowed as a last resort.
- **`box-decoration-break`** (§5.4, initial value `slice`): no border or padding is inserted at the break.
- **Margins at breaks** (§5.2, #break-margins): margins adjoining an unforced break are truncated to zero. After a forced break, they are kept.

## CSS Paged Media Level 3 — https://www.w3.org/TR/css-page-3/

- §3 (#page-model): "The edges of the page area on the first page establish the rectangle that is the initial containing block." We therefore lay out at the page content width.
- §7.1 (#page-size-prop): named sizes include A5, A4, A3, B5, B4, letter, legal and ledger. Orientation is `portrait` or `landscape`.
- §5 (#margin-boxes): the page margin area is divided into 16 page-margin boxes.

## CSS Tables Level 3 — https://www.w3.org/TR/css-tables-3/#breaking-rules (§6)

- **Breaking rows** (§6.1)
  - A row whose cells don't span later rows and which is short enough should not be fragmented. Instead, a gap moves it to the next page.
  - If a row must break, each cell's content breaks independently. Top borders are not repainted in continuation fragments.
- **Repeating headers and footers** (§6.2, #repeated-headers)
  - Headers and footers repeat when they have `break-inside: avoid`.
  - Each must take up no more than ¼ of the page height.
  - Repeating must never place the same row on a page twice.

## CSSOM View — https://drafts.csswg.org/cssom-view/

- `Element.getClientRects()` returns one border-box rect per box fragment, so an inline element wrapped across N lines yields N rects.
- `Range.getClientRects()` on a Text node returns a rect for the selected part of each line fragment.
- Text rect height comes from the font's ascent and descent, not from line-height.

## PDF 32000-1:2008 — https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf

| Section | Use in zedpdf |
|---|---|
| §7.5.2 | Header plus a binary comment line with bytes ≥ 128 |
| §7.5.4 | xref entries are exactly 20 bytes (`nnnnnnnnnn ggggg n\r\n`); object 0 is free with generation 65535 |
| §7.5.5 | trailer `/Size /Root /Info`, `startxref`, `%%EOF` |
| §7.7.3 | Page tree (`/Pages /Kids /Count`), page objects (`/Parent /Resources /MediaBox`) |
| §7.8 | Content streams; resources are referenced by name |
| §9.3.3 | **`Tw` does not apply to 2-byte codes**, so we position words with `TJ` adjustments |
| §9.3.6 | Text render mode 3 = invisible (used for the text layer over rasterized complex-script words) |
| §9.4.3 | `TJ` numbers are thousandths of text space and are *subtracted* from the position |
| §9.6.2.2 | Standard 14 fonts (fallback when no font bytes are available) |
| §9.6.4 | Subset tag: six uppercase letters plus `+` |
| §9.7.4–9.7.6 | Type0 / CIDFontType2, `/W` widths, `CIDToGIDMap /Identity`, `Identity-H` |
| §9.9 | `FontFile2` with `Length1`; a CIDFontType2 program "cmap table … shall not be present" |
| §9.10 | **Identity-H text is not extractable without ToUnicode**; the bfchar/bfrange CMap maps to UTF-16BE |
| §8.9.5 | Image dictionaries, `SMask` |
| §7.4.4.3–4 | Flate `DecodeParms`: Predictor 15 lets PNG IDAT pass through unchanged |
| §11.6.5.3 | SMask is a DeviceGray image |
| §11.6.4.4 | `ca` / `CA` constant alpha set via ExtGState |

## Competitors (documentation)

- **html2pdf.js** (https://github.com/eKoopmans/html2pdf.js)
  - Takes an html2canvas screenshot and has jsPDF place it as an image. The README says text "is not selectable or searchable".
  - Canvas size limits can produce blank PDFs for long documents.
  - Page-break modes: `avoid-all`, `css`, `legacy`.
- **pdfmake** (https://github.com/bpampuch/pdfmake)
  - Builds from a JS document definition, not HTML.
  - Tables support `headerRows` and `keepWithHeaderRows`; rows can be kept together with `dontBreakRows`.
  - Fonts are embedded via a vfs. Text is vector.
  - html-to-pdfmake converts a subset of HTML.
- **Paged.js** (https://pagedjs.org/en/documentation/4-how-paged.js-works/)
  - A polyfill whose Chunker splits the DOM into pages. The PDF is then made with the browser's own Save as PDF, or with pagedjs-cli and headless Chromium.
  - Repeating thead is not documented as native.
- **jsPDF `.html()`**: uses html2canvas. Its autoPaging `'slice'` mode "will possibly slice text in half".

## Browser support (MDN browser-compat-data)

| Feature | Chromium | Firefox | WebKit |
|---|---|---|---|
| `widows` / `orphans` | 25+ | **no** (behaves like 1) | yes |
| `break-inside: avoid` | 50 | 65 | 10 |
| Repeating `thead` in print | yes (2016) | yes | **no** (WebKit bug 17205, open) |
| `CompressionStream('deflate')` | 80 | 113 | 16.4 |
| `DecompressionStream('brotli')` | no | 147 | 18.4 |
