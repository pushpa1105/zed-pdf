// Zero-dependency static file server for the demo, fixtures and examples.
// Usage: node scripts/serve.mjs [port] [root]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

export function serve(port = 4173, root = resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = normalize(join(root, decodeURIComponent(url.pathname)));
      if (!p.startsWith(root)) {
        res.writeHead(403).end();
        return;
      }
      let s = await stat(p).catch(() => null);
      if (s?.isDirectory()) {
        p = join(p, 'index.html');
        s = await stat(p).catch(() => null);
      }
      if (!s) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[extname(p).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(await readFile(p));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) {
  const port = +(process.argv[2] ?? 4173);
  const root = process.argv[3] ? resolve(process.argv[3]) : undefined;
  await serve(port, root);
  console.log(`zedpdf: serving on http://127.0.0.1:${port}/  (demo: /demo/)`);
}
