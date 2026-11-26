// Benchmark: 1,000-row invoice (and 200 for scale), measured in-page. Writes samples/bench.json.
import os from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import { startServer, launch, exportInPage, openFixture } from './lib/browser.mjs';
import { inspect } from './lib/pdf-tools.mjs';

const RUNS = +(process.env.RUNS ?? 5);
const engines = (process.env.ENGINES ?? 'chromium').split(',');
const sizes = (process.env.ROWS ?? '200,1000').split(',').map(Number);
const { server, base } = await startServer();
const results = [];
for (const engine of engines) {
  // Chromium only reports unquantized heap sizes with this flag.
  const browser = await launch(engine, engine === 'chromium' ? { args: ['--enable-precise-memory-info'] } : {});
  for (const rows of sizes) {
    const page = await openFixture(browser, base, `preset=long&rows=${rows}`);
    const runs = [];
    let last;
    for (let i = 0; i < RUNS; i++) {
      const heapBefore = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : null));
      last = await exportInPage(page, '#invoice', { format: 'A4', margin: '10mm' });
      const heapAfter = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : null));
      // Retained after the export resolves (the returned Blob is still referenced by the harness).
      runs.push({ ms: Math.round(last.ms), timings: last.timings, heapDeltaMB: heapBefore != null ? +((heapAfter - heapBefore) / 1048576).toFixed(1) : null });
    }
    const info = await inspect(last.bytes);
    const sorted = runs.map((r) => r.ms).sort((a, b) => a - b);
    const res = {
      engine,
      version: browser.version(),
      rows,
      runs: RUNS,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      pages: last.pageCount,
      bytes: last.bytes.length,
      valid: info.xref.ok && !info.mupdfRepaired,
      stageMedians: Object.fromEntries(Object.keys(runs[0].timings).map((k) => [k, runs.map((r) => r.timings[k]).sort((a, b) => a - b)[Math.floor(RUNS / 2)]])),
      heapDeltaMB: runs.map((r) => r.heapDeltaMB),
    };
    results.push(res);
    console.log(JSON.stringify(res));
    await page.close();
  }
  await browser.close();
}
server.close();
const hw = { cpu: os.cpus()[0].model, cores: os.cpus().length, memGB: +(os.totalmem() / 2 ** 30).toFixed(1), os: `${os.type()} ${os.release()}`, node: process.version };
mkdirSync(new URL('../samples/', import.meta.url), { recursive: true });
writeFileSync(new URL('../samples/bench.json', import.meta.url), JSON.stringify({ hardware: hw, date: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify(hw));
