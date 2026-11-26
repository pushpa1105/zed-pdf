// Build: ESM bundle + IIFE global bundle (esbuild) and .d.ts (tsc). No runtime deps are bundled
// because the library has none.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true });

const common = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  target: ['chrome100', 'firefox100', 'safari16'],
  define: { __ZEDPDF_VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
  logLevel: 'warning',
};

await build({ ...common, format: 'esm', outfile: 'dist/zedpdf.js', sourcemap: true });
await build({ ...common, entryPoints: ['src/global.ts'], format: 'iife', globalName: 'ZedPdf', outfile: 'dist/zedpdf.global.js', minify: true, sourcemap: true });
execSync('npx tsc -p tsconfig.json', { stdio: 'inherit' });
console.log(`built zedpdf ${pkg.version}`);
