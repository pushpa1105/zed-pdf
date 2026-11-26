# Changelog

All notable changes to **zedpdf** are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is below 1.0.0, a minor release (0.**x**.0) may contain breaking changes. These are always listed under **Breaking**.

<!-- Add new entries under "Unreleased". `pnpm release:version <patch|minor|major|x.y.z>` turns that section into the new version. -->

## [Unreleased]

## [0.1.0] - 2026-11-27

First public release.

### Added

- `pdf(target, options)` handle with `.download()`, `.print()`, `.open()`, `.preview(el)`, `.share()`, `.file()` and `.blob()`.
- `exportPdf(element, options)` returning a `PdfFile` (`Blob`) with page count, warnings and timings.
- `printElement()` for the browser's native print dialog, and `savePdf()` for saving any PDF blob.
- `bindActions()` and the script-tag build (`zedpdf/global`) with `data-zedpdf="download|print|open|preview|share"` buttons, so plain HTML pages need no script of their own.
- Real, selectable and searchable text with embedded, subset TrueType/OpenType/WOFF fonts (Type0/CID with ToUnicode). The 14 standard PDF fonts are used as the fallback.
- Vector backgrounds, borders and rounded corners. Images are stored at print resolution, and link annotations are kept.
- Content-aware pagination following CSS Fragmentation Level 3: table rows and text lines are never cut, `<thead>` repeats on every page, and `break-before`, `break-after` and `break-inside` are honoured, along with orphans and widows.
- Page setup: `format` (A3, A4, A5, Letter, Legal or a custom size), `orientation`, `margin`, and headers and footers with page numbers.
- Styling context: stylesheets, CSS-in-JS, adopted stylesheets, ancestor selectors and CSS variables resolve as on screen. Use `media: 'print' | 'screen'` and extra `css`.
- Warnings with codes and remedies (for example `font-substituted`, `asset-unavailable` and `horizontal-overflow`), `strict` mode, `AbortSignal` cancellation and `onProgress`.
- `assetResolver` for images and fonts behind authentication or on other domains.
- ESM build with TypeScript declarations, a minified IIFE global build (`ZedPdf`), zero runtime dependencies.

[Unreleased]: https://github.com/pushpa1105/zed-pdfer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/pushpa1105/zed-pdfer/releases/tag/v0.1.0
