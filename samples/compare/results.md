# HTML→PDF comparison on the invoice fixture

Fixture: `fixtures/invoice.html?preset=two-page (28 rows)` · generated 2026-11-25T18:50:34.028Z

Versions: html2pdf.js 0.14.0, pdfmake 0.3.15, html-to-pdfmake 2.6.0, pagedjs 0.4.3, zedpdf 0.1.0, @playwright/test 1.65.1, node v24.22.1, chromium 159.0.8154.6

| tool | ms (median) | pages | bytes | opens MuPDF / pdf.js | xref ok | text | ids once (in order) | grand total found | header on every item page | row split across pages | screen-only banner leaked | text items beyond page edge | p1 pixel diff vs native % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| chromium-print | 158.4 | 3 | 71747 | yes / yes | yes | yes | 28/28 | 1× | yes | none detected | no | 0 | — |
| zedpdf | 149.8 | 3 | 49556 | yes / yes | yes | yes | 28/28 | 1× | yes | none detected | no | 0 | 3.04 |
| html2pdf | 366.9 | 2 | 1047526 | yes / yes | yes | no | 0/28 | 0× | n/a | n/a (no text) | n/a | n/a | 10.08 |
| pdfmake | 143.8 | 3 | 69277 | yes / yes | yes | yes | 28/28 | 1× | yes | ITEM-0002 (p1) continues on p2: "Office chair (refurbished) Ergonomic mesh back, adjustable l"; ITEM-0017 (p2) continues on p3: "Galvanised, 5 tiers, 180 × 90 × 40 cm" | yes | 33 | 8.9 |
| pagedjs | 214.1 | 2 | 70811 | yes / yes | yes | yes | 28/28 | 1× | no | none detected | no | 0 | 3.29 |

ms runs (each in a fresh page): chromium-print [168.7, 158.4, 132.6]; zedpdf [154.4, 149.8, 143.6]; html2pdf [375.9, 366.9, 351.8]; pdfmake [154, 143.8, 141.3]; pagedjs [215.4, 199.5, 214.1].

Timing column: chromium-print = Node-side page.pdf() round trip; zedpdf = in-page exportPdf(); html2pdf = in-page html2pdf().outputPdf(); pdfmake = in-page htmlToPdfmake()+createPdf().getBuffer(); pagedjs = in-page PagedPolyfill.preview() + Node-side page.pdf().
Pixel diff is pixelmatch (threshold 0.15) of page 1 at 96 dpi vs native print page 1, cropped to the common size; it is a coarse layout-drift signal, not a quality score.

## Notes per tool (measured/logged by the script)
- **chromium-print**: Prints the whole page (fixture #mount wrapper), print media. Fonts referenced: AAAAAA+NotoSans-Regular, BAAAAA+NotoSans-Bold, CAAAAA+Arial-BoldMT, DAAAAA+NotoSans-Italic.
- **zedpdf**: zedpdf warnings: [{"code":"image-rasterized","severity":"info","message":"SVG image rasterized at 288 dpi","element":"div.meta > table > tbody > tr:nth-child(4) > td:nth-child(2) > img.stamp","count":1},{"code":"image-downsampled","severity":"info","message":"Image downsampled from 400×300 to 150×113 px for 300 dpi (12 KB → 4 KB)","element":"div#invoice > table.items > tbody > tr:nth-child(2) > td.desc > img.thumb","remedy":"Set maxImageDpi: false to keep the original resolution","count":1}] Fonts referenced: ADFDVI+NotoSans-Regular, FACQHZ+NotoSans-Bold, HCUMEG+NotoSans-Italic.
- **html2pdf**: Options: margin 10 (jsPDF unit mm), jsPDF a4 portrait, image jpeg 0.98, html2canvas scale 2, pagebreak css+legacy. Fonts referenced: Helvetica, Helvetica-Bold, Helvetica-Oblique, Helvetica-BoldOblique, Courier, Courier-Bold, Courier-Oblique, Courier-BoldOblique, Times-Roman, Times-Bold, Times-Italic, Times-BoldItalic, ZapfDingbats, Symbol.
- **pdfmake**: Default pdfmake fonts (Roboto from vfs_fonts.js); html-to-pdfmake options: imagesByReference, tableAutoSize; pageMargins 28.35pt; defaultStyle fontSize 9 (≈12px). as-is conversion FAILED: page.evaluate: Error: Invalid image: Error: Unknown image format. Workaround applied and succeeded (see log). set data-pdfmake='{"headerRows":1}' on table.items (html-to-pdfmake does not map <thead> to headerRows by itself) replaced <img src=/fixtures/assets/paid-stamp.svg> with inline <svg> conversion (html-to-pdfmake) 12 ms of 141 ms total Fonts referenced: BZZZZZ+Roboto-Regular, CZZZZZ+Roboto-Medium, DZZZZZ+Roboto-Italic. Row splits: ITEM-0002 (p1) continues on p2: "Office chair (refurbished) Ergonomic mesh back, adjustable l"; ITEM-0017 (p2) continues on p3: "Galvanised, 5 tiers, 180 × 90 × 40 cm". Text beyond page edge e.g. p1:"Am" p1:"(NP" p1:"189" p1:"782" p2:"Am" p2:"(NP".
- **pagedjs**: Paged.js paginate 87 ms + page.pdf 127 ms; Paged.js reported 2 pages Fonts referenced: AAAAAA+NotoSans-Regular, BAAAAA+NotoSans-Bold, CAAAAA+Arial-BoldMT, DAAAAA+NotoSans-Italic.

## Visual fidelity vs native print (manual observation of the PNGs, NOT computed)
- **chromium-print**: Reference. Noto Sans, blue header row, zebra rows, rounded party boxes, PAID stamp as vector. p1 ends after ITEM-0013; p2 repeats the table header; p3 holds only the closing note.
- **zedpdf**: Visually near-identical to native on p1 (same fonts, colors, page breaks: 13 rows on p1, repeated header on p2, note alone on p3). Sub-pixel text position drift (~1px). PAID stamp is rasterized (zedpdf info warning).
- **html2pdf**: Whole page is a JPEG (no text layer, ~1 MB). Fonts/colors look like the screen render, BUT it captured screen media: the red "SCREEN-ONLY BANNER (hidden in print/export)" is visible, shifting everything ~30px down. Breaks rows cleanly (13 rows p1) but no repeated header on p2; 2 pages total.
- **pdfmake**: Very different layout: class-based CSS is not applied (no flex header, no blue header row, no zebra, no rounded boxes; plain bordered tables). Roboto instead of Noto Sans. Logo rendered at natural size (huge). Product thumbnail rendered at natural size, pushing ITEM-0002 description to p2. Items table overflows the right margin: "Amount (NPR)" column is clipped off the page. Screen-only banner rendered (no CSS). Header row does repeat (after data-pdfmake headerRows workaround).
- **pagedjs**: p1 visually matches native print (same fonts/colors/break). p2 has NO repeated table header (Paged.js splits the table into a new fragment without the thead), so the content fits on 2 pages and the closing note lands on p2 instead of p3.
