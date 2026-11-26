# zedpdf workspace

**zedpdf** turns an on-screen HTML element (invoice, quotation, purchase order, report) into a real PDF entirely in the browser:
- selectable, searchable text;
- vector boxes;
- embedded fonts;
- sharp images;
- page breaks that respect table rows and lines.

It has zero runtime dependencies. The npm package lives in [`packages/zedpdf`](packages/zedpdf); its README is the user documentation and API reference.

**[Website & docs](https://pushpa1105.github.io/zed-pdf/)** · [Changelog](packages/zedpdf/CHANGELOG.md) · [Releasing](RELEASING.md) · [npm](https://www.npmjs.com/package/zedpdf)

```js
import { pdf } from 'zedpdf';

const invoice = pdf('#invoice', { format: 'A4', margin: '12mm', filename: 'INV-42' });
await invoice.download();          // also: .print() .open() .preview('#viewer') .share() .file() .blob()
```

```html
<!-- or, with the script-tag build, no JavaScript at all -->
<button data-zedpdf="download" data-zedpdf-target="#invoice">Download PDF</button>
```

## Repository layout

| Path | Contents |
|---|---|
| `packages/zedpdf/` | The library: TypeScript source, unit tests, build. This is what gets published |
| `site/` | Website: landing page with a live playground running the real build, fidelity vs Chrome print, comparison table; `docs.html` (guides + API reference); `changelog.html` (generated from the CHANGELOG). Built into `dist-site/` and deployed to GitHub Pages |
| `demo/` | Demo app (plain ES modules): presets, paper/margins, Preview / Download / Native Print, warnings |
| `examples/` | Consumer apps: `plain-html` (no bundler), `vue` (template ref + scoped CSS), `react` (`useRef` + ancestor theme) |
| `fixtures/` | Deterministic invoice, boundary and styling-context fixtures; local OFL fonts and images |
| `tests/` | Playwright end-to-end tests (validated with MuPDF + pdf.js) |
| `scripts/` | Static server, M1 experiment, samples, compat report, benchmark, pack verification |
| `research/compare/` | Reproducible comparison with html2pdf.js, pdfmake and Paged.js (separate `package.json`) |
| `samples/` | Generated PDFs, renders, diffs and JSON reports |
| `.github/` | CI, GitHub Pages deploy and npm release workflows (see [RELEASING.md](RELEASING.md)) |
| `docs/` | [Research & architecture](docs/research-and-architecture.md) · [sources](docs/research-sources.md) · [support matrix](docs/support-matrix.md) · [milestones & results](docs/milestones.md) |

## Commands

```sh
pnpm install
pnpm build            # dist: ESM + global IIFE + .d.ts
pnpm test             # 32 unit tests (vitest)
pnpm test:e2e         # Playwright: Chromium suite + Firefox/WebKit @compat
pnpm serve            # http://127.0.0.1:4791/demo/
pnpm site             # build the showcase into dist-site/
pnpm site:preview     # build + serve it at http://127.0.0.1:4792/
pnpm m1               # Milestone 1 experiment vs Chromium print → samples/m1
pnpm samples          # samples/pdfs
pnpm compat           # 5 presets × Chromium/Firefox/WebKit → samples/compat
pnpm bench            # 200/1,000 rows → samples/bench.json
pnpm pack:verify      # pack tarball, clean-install into 3 example apps, export through their UI
pnpm check            # build + typecheck + unit + e2e + pack:verify
pnpm release:version minor   # bump version + roll CHANGELOG (see RELEASING.md)
pnpm release:notes    # print the current version's release notes
```

## Status (0.1.0)

- **Fidelity.** The direct export matches Chromium print-to-PDF on the reference invoice: same page breaks, text positions within 0.35 pt, ≤ 0.17 % pixel difference per page at matched geometry.
- **Tests.**
  - 32 unit tests and 29 end-to-end tests pass.
  - 15/15 compat runs pass across Chromium, Firefox and WebKit.
  - The packed tarball was verified in clean plain-HTML, Vue and React apps.

## Releases

Versions follow [semver](https://semver.org/) and every change is recorded in [`packages/zedpdf/CHANGELOG.md`](packages/zedpdf/CHANGELOG.md).
To release, run `pnpm release:version <patch|minor|major>`, commit, then push a `vX.Y.Z` tag. GitHub Actions then tests the build, publishes it to npm with provenance and creates the GitHub Release.
The website redeploys from `main`. [RELEASING.md](RELEASING.md) has the one-time setup (Pages, npm token), the first-release steps, pre-releases and the versioning policy.

## License

MIT. See [`packages/zedpdf/LICENSE`](packages/zedpdf/LICENSE).
