// Pack the npm tarball, check its contents, then install it into clean copies of the plain HTML,
// Vue and React examples, build them, and export a PDF through each app's normal UI.
// Writes samples/consumers/{report.json, *.pdf}.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { serve } from './serve.mjs';
import { inspect, extract } from './lib/pdf-tools.mjs';
import { pdfObjects } from '../tests/helpers.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tmp = join(root, '.tmp');
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
const report = { steps: [] };
const step = (name, data) => {
  report.steps.push({ name, ...data });
  console.log(`✓ ${name}`, data ? JSON.stringify(data) : '');
};

// 1. Build and pack.
sh('node build.mjs', join(root, 'packages/zedpdf'));
rmSync(join(tmp, 'pack'), { recursive: true, force: true });
mkdirSync(join(tmp, 'pack'), { recursive: true });
sh(`pnpm pack --pack-destination "${join(tmp, 'pack')}"`, join(root, 'packages/zedpdf'));
const tgzName = readdirSync(join(tmp, 'pack')).find((f) => f.endsWith('.tgz'));
const tgz = join(tmp, 'pack', tgzName);
const files = sh(`tar -tzf "${tgzName}"`, join(tmp, 'pack')).trim().split(/\r?\n/);
const pkg = JSON.parse(sh(`tar -xzOf "${tgzName}" package/package.json`, join(tmp, 'pack')));
const unexpected = files.filter((f) => !/^package\/(dist\/|README\.md$|CHANGELOG\.md$|LICENSE$|package\.json$)/.test(f));
if (unexpected.length) throw new Error(`unexpected files in tarball: ${unexpected.join(', ')}`);
if (pkg.dependencies && Object.keys(pkg.dependencies).length) throw new Error('runtime dependencies present');
const sizeKB = +(readFileSync(tgz).length / 1024).toFixed(1);
step('pack', { tarball: tgzName, files: files.length, sizeKB, runtimeDependencies: 0, exports: Object.keys(pkg.exports) });

// 2. Clean consumer installs.
const consumers = [
  { name: 'plain-html', build: false, dir: '', prefix: 'PLAIN', color: '0.0627 0.3686 0.651 rg' },
  { name: 'vue', build: true, dir: 'dist', prefix: 'VUE', color: '0.0392 0.4706 0.2353 rg' },
  { name: 'react', build: true, dir: 'dist', prefix: 'REACT', color: '0.8627 0.1569 0.3922 rg' },
];
const out = join(root, 'samples/consumers');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const c of consumers) {
  const dir = join(tmp, 'consumers', c.name);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(root, 'examples', c.name), dir, { recursive: true, filter: (s) => !/node_modules|[\\/]dist$/.test(s) });
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  pj.dependencies.zedpdf = `file:${tgz.replace(/\\/g, '/')}`;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pj, null, 2));
  sh('npm install --no-audit --no-fund --loglevel=error', dir);
  const installed = JSON.parse(readFileSync(join(dir, 'node_modules/zedpdf/package.json'), 'utf8')).version;
  if (existsSync(join(dir, 'node_modules/zedpdf/src'))) throw new Error('source shipped in tarball');
  if (c.build) sh('npm run build --silent', dir);
  const port = 5100 + consumers.indexOf(c);
  const server = await serve(port, join(dir, c.dir));
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#download');
  await page.evaluate(() => document.fonts.ready);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  if (dl.suggestedFilename() !== `invoice-${c.name === 'plain-html' ? 'plain' : c.name}.pdf`) throw new Error(`${c.name}: unexpected file name ${dl.suggestedFilename()}`);
  const bytes = readFileSync(await dl.path());
  writeFileSync(join(out, `${c.name}.pdf`), bytes);
  const info = await inspect(bytes);
  const pages = await extract(bytes);
  const text = pages.map((p) => p.text).join('\n');
  const ids = text.match(new RegExp(`${c.prefix}-\\d{3}`, 'g')) ?? [];
  const expected = Array.from({ length: 60 }, (_, i) => `${c.prefix}-${String(i + 1).padStart(3, '0')}`);
  const content = pdfObjects(bytes).filter((o) => o.data && !/Length1|Subtype/.test(o.dict)).map((o) => o.data.toString('latin1')).join('\n');
  const result = {
    installedVersion: installed,
    pages: pages.length,
    valid: info.xref.ok && info.mupdfRepaired === false,
    idsOnceInOrder: JSON.stringify(ids) === JSON.stringify(expected),
    headerOnEveryPage: pages.every((p) => p.text.includes('Description')),
    themeColour: content.includes(c.color),
    fontEmbedded: /FontFile2/.test(Buffer.from(bytes).toString('latin1')),
    status: await page.textContent('#status'),
    pageErrors: errors,
  };
  if (!result.valid || !result.idsOnceInOrder || !result.headerOnEveryPage || !result.themeColour || errors.length) {
    throw new Error(`${c.name} failed: ${JSON.stringify(result)}`);
  }
  step(`consumer:${c.name}`, result);
  await page.close();
  server.close();
}
await browser.close();
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log('pack-verify OK');
