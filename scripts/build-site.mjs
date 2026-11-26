// Build the static showcase site into dist-site/ (deployable as-is, e.g. GitHub Pages).
// Copies the site source, the built library, the invoice fixture and pre-generated sample renders,
// fills {{VERSION}} / {{REPO}} from packages/zedpdf/package.json and renders CHANGELOG.md into changelog.html.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderChangelog } from './lib/changelog-html.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'dist-site');
const need = (p) => {
  if (!existsSync(join(root, p))) throw new Error(`missing ${p}: run "pnpm m1" and "pnpm samples" first`);
  return join(root, p);
};

execSync('node build.mjs', { cwd: join(root, 'packages/zedpdf'), stdio: 'inherit' });
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'lib'), { recursive: true });
mkdirSync(join(out, 'samples'), { recursive: true });

cpSync(join(root, 'site'), out, { recursive: true });
cpSync(join(root, 'packages/zedpdf/dist/zedpdf.js'), join(out, 'lib/zedpdf.js'));
cpSync(join(root, 'packages/zedpdf/dist/zedpdf.js.map'), join(out, 'lib/zedpdf.js.map'));
cpSync(join(root, 'fixtures/invoice.js'), join(out, 'fixtures/invoice.js'));
cpSync(join(root, 'fixtures/invoice.css'), join(out, 'fixtures/invoice.css'));
cpSync(join(root, 'fixtures/assets'), join(out, 'fixtures/assets'), { recursive: true });

const samples = {
  'samples/m1/zedpdf-p1.png': 'zedpdf-p1.png',
  'samples/m1/zedpdf-p2.png': 'zedpdf-p2.png',
  'samples/m1/print-p1.png': 'print-p1.png',
  'samples/m1/diff-p1.png': 'diff-p1.png',
  'samples/compare/zedpdf-p1.png': 'compare-zedpdf.png',
  'samples/compare/pagedjs-p1.png': 'compare-pagedjs.png',
  'samples/compare/pdfmake-p1.png': 'compare-pdfmake.png',
  'samples/compare/html2pdf-p1.png': 'compare-html2pdf.png',
  'samples/pdfs/invoice-two-page.pdf': 'invoice-two-page.pdf',
};
for (const [from, to] of Object.entries(samples)) cpSync(need(from), join(out, 'samples', to));
// ---- version, repository links and the changelog page
const pkg = JSON.parse(readFileSync(join(root, 'packages/zedpdf/package.json'), 'utf8'));
const repo = (pkg.repository?.url ?? '').replace(/^git+/, '').replace(/.git$/, '');
if (!repo) throw new Error('packages/zedpdf/package.json needs a "repository" url');
const changelog = renderChangelog(readFileSync(join(root, 'packages/zedpdf/CHANGELOG.md'), 'utf8'), { repo });
for (const file of readdirSync(out).filter((f) => f.endsWith('.html'))) {
  const path = join(out, file);
  const html = readFileSync(path, 'utf8')
    .replace('<!-- CHANGELOG:NAV -->', () => changelog.nav)
    .replace('<!-- CHANGELOG:BODY -->', () => changelog.html)
    .replaceAll('{{VERSION}}', pkg.version)
    .replaceAll('{{REPO}}', repo);
  if (/{{[A-Z_]+}}/.test(html)) throw new Error(`unreplaced placeholder in ${file}`);
  writeFileSync(path, html);
}
writeFileSync(join(out, '.nojekyll'), ''); // GitHub Pages: serve files as-is

console.log(`site built → ${out} (zedpdf ${pkg.version}, latest changelog entry ${changelog.latest})`);
