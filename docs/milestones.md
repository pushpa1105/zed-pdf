# Milestones: commands and recorded results

**Environment:**
- Hardware and OS: Windows 11 (10.0.26300), AMD Ryzen 7 5800H, 16 cores, 15.4 GB.
- Toolchain: Node 24.22.1, pnpm 10.16.1.
- Playwright 1.65.1 browsers: Chromium 159.0.8154.6, Firefox 159.0, WebKit 27.2.

**Setup (once):**

```sh
pnpm install
pnpm build                      # packages/zedpdf/dist (esbuild ESM + IIFE, tsc .d.ts)
```

## Milestone 1: verified two-page direct download and native-print comparison

```sh
pnpm m1                         # node scripts/m1-experiment.mjs → samples/m1/
```

**Result** (`samples/m1/report.json`):

*zedpdf output*
- 3 pages, 83 KB, 157 ms in-page.
- Warnings: one info only (SVG stamp rasterized).
- MuPDF opens it without repair. pdf.js opens it. The xref check passes (34 objects, each entry exactly 20 bytes).

*Chromium print reference:* 3 pages, 72 KB.

*Comparison at matched geometry (595.92 × 841.92 pt, 37 px margins)*
- 28/28 IDs on the same page.
- max dx 0.00 pt, max dy 0.35 pt.
- Pixel diff 0.17 % / 0.13 % / 0 %.

*Renders:* independent MuPDF renders in `samples/m1/*.png`; diffs in `samples/m1/diff-p*.png`.

**Fixes made during this milestone:**
- `@font-face` discovery: the cross-realm `instanceof` check failed, so Helvetica was substituted.
- Text state leaked between runs and extracted as "I n v o i c e": every run is now wrapped in `q/Q`.
- The list-marker float changed line wrapping: switched to an absolutely positioned marker.

## Milestone 2: long-invoice paginator, assets, independent correctness tests

```sh
pnpm test                       # vitest: 32 unit tests (paginator, PDF writer, fonts, PNG/JPEG, page model, media rewriting)
pnpm exec playwright test       # 28 e2e tests in Chromium + the @compat test in Firefox and WebKit
pnpm compat                     # samples/compat/report.json (5 presets × 3 engines)
pnpm samples                    # samples/pdfs/*.pdf (+ Chromium print references)
```

**Results (final run):**
- **Unit tests:** 32/32 pass.
- **End-to-end tests:** 28/28 pass across Chromium, Firefox and WebKit.
- **200 rows:** each ID once and in order; grand total once; header above the first row on every page with rows; no blank trailing page.
- **Boundaries:**
  - exact fit stays;
  - 80.5 px row moves;
  - full-page row gets its own page;
  - a 120-line row spans 4 pages with every line once and its amount once;
  - totals move intact, or split with `break-inside-relaxed`;
  - colspan column right edges agree within 0.3 pt;
  - rowspan group moved intact;
  - a tall header is not repeated (warning);
  - an oversized image is scaled (warning) or sliced (warning).
- **Geometry (200 rows):**
  - no glyph outside the printable area;
  - amount column right edge varies by < 0.5 pt across 11 pages;
  - rows strictly increasing in y and never overlapping;
  - logo drawn at 3:1.
- **Context:**
  - Vue scoped border colour is present in the render;
  - React ancestor theme gives the background `var(--surface)`, the heading `var(--accent)` and the embedded Noto Sans;
  - `@media print` is applied and `@media screen` disabled; `media: 'screen'` and `options.css` work.
- **Assets:**
  - PNG transparency: background visible through the logo's transparent corner (both copies);
  - logo embedded once (image + SMask);
  - JPEG passthrough;
  - a missing image gives `asset-unavailable` with its element path, and strict mode rejects.
- **Cancellation:** aborts at 0, 5, 30 and 80 ms reject with `aborted`; no iframe remains; the original DOM is untouched.
- **Compat:** all 15 engine × preset runs are valid, keep ID order and show the total once.

**Fixes made during this milestone:**
- Rows with `break-inside: avoid` taller than a page now move to a fresh page before splitting, matching Chromium. The oversized preset went from 3 pages to 4, the same as print.
- Invisible-text words in the raster fallback are scaled to their measured box, so extractors no longer break lines.
- Unused Core-14 fallback fonts are no longer written.
- The test server binds to 127.0.0.1:4791 because another local process owned 127.0.0.1:4173.

## Milestone 3: demo, three consumer integrations, verified tarball, compatibility guide

```sh
pnpm serve                      # http://127.0.0.1:4791/demo/  (plain ES modules, local assets)
pnpm pack:verify                # pack → clean installs of examples/{plain-html,vue,react} → build → click Download
pnpm bench                      # ENGINES=chromium,firefox,webkit RUNS=5 → samples/bench.json
```

**Results:**
- **Tarball:** `zedpdf-0.1.0.tgz`, 267.9 KB, 24 files (dist, README, LICENSE, package.json). 0 runtime dependencies. Exports `.`, `./global`, `./package.json`.
- **Bundles:**

  | Build | Raw | gzip |
  |---|---|---|
  | ESM | 153 KB | 43 KB |
  | Minified global | 92 KB | 34 KB |

- **Consumer apps:** plain HTML (served `node_modules` ESM, no bundler), Vue 3 + Vite 7 and React 19 + Vite 7. Each installed the tarball from scratch, built, and exported through its own Download button: 2 pages, 60 IDs once and in order, header on both pages, theme colour present, font embedded, 0 warnings, no page errors.
- **Demo:** `tests/demo.spec.mjs` checks:
  - Preview shows the real Blob URL;
  - Download yields a valid 3-page PDF with "Page N of 3" footers;
  - switching preset revokes the previous object URL;
  - the missing-image warning is shown;
  - no export iframe is left behind.
- **Benchmark** (median of 5, in-page):

  | Engine | 200 rows (11 pages) | 1,000 rows (49 pages, ≈ 309 KB) |
  |---|---|---|
  | Chromium | 0.22 s | 0.86 s |
  | Firefox | 0.29 s | 0.87 s |
  | WebKit | 0.74 s | 2.36 s |

  - An earlier run on the same machine, made while other work was running, measured 1.6 s / 0.95 s / 5.8 s for 1,000 rows. Expect that level of variance.
  - Chromium JS heap retained after an export (`--enable-precise-memory-info`) ranged from −16 MB to +40 MB across runs, with no monotonic growth.
  - Peak heap during an export was not measured.
- **Competitor comparison:** `cd research/compare && npm install && node run.mjs` writes `samples/compare/`; see [research-and-architecture.md](research-and-architecture.md).

## Iteration 2: file size, web-app coverage, showcase site

```sh
pnpm exec playwright test tests/size.spec.mjs tests/webapp.spec.mjs tests/site.spec.mjs
pnpm samples && pnpm site
```

**File size** (same documents, Chromium 159):

| Document | Before | After | Chromium print |
|---|---|---|---|
| Two-page invoice | 83 KB | 49 KB | 72 KB |
| 1,000-row invoice | 309 KB | 221 KB | 283 KB |
| Nepali/English (raster fallback) | 178 KB | 82 KB | 77 KB |

How the savings were made:
- **Fonts: compact subsets with a CIDToGIDMap stream.** Font data went from 39 KB to 11 KB.
- **Images sized for print.** Images are embedded at `maxImageDpi` (300). For example, a 3000×2000 JPEG shown at 240 px is embedded at 750×500, and a 1.4 MB RGBA PNG is embedded at 375×375 with its alpha kept (61 KB).
- **Lossless images:** PNG row filters (Predictor 15).
- **Raster words:** a 1×1 colour image plus a soft mask, deduplicated per word.
- **Drawing instructions:** a graphics-state tracker emits changes only, single-side borders are drawn as `re`, and coordinates use 2 decimals.

The result was verified by a pixel comparison of MuPDF against pdf.js renders (< 2 %). Fidelity versus print is unchanged: dx 0.00 pt, dy ≤ 0.35 pt, 0.17 % / 0.13 % / 0 %.

**Web-app kitchen sink** (`fixtures/webapp.html`, `tests/webapp.spec.mjs`, run in Chromium, Firefox and WebKit):
- All 31 markers appear exactly once and in order.
- The nested table paginates inside a row taller than a page, with both headers repeated.
- Multi-column lists read in column order.
- Closed `<details>` content is hidden.
- Two icon colours produce two rasters, and the canvas chart is embedded.
- Links are clickable (pdf.js reads both URLs).
- No warnings of `warning` severity.
- The page count is within one of native print.

**Fixes found by the kitchen sink:**
- Closed `details` content leaked into the export.
- Multi-column reading order was wrong.
- Checkbox, list-bullet and disclosure glyphs were missing; they are now vector shapes.
- The SVG cache ignored `currentColor`.
- Transparent border sides lost their width, which broke CSS triangles.

**Showcase site** (`site/`, built into `dist-site/`):
- Landing page and documentation page.
- Light and dark themes: OS default, a persistent toggle, no flash on load.
- `tests/site.spec.mjs` covers the playground export, theme switching and persistence, and that every docs anchor resolves and no image is broken.
