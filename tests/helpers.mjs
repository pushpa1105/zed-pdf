import { exportInPage, nativePrint } from '../scripts/lib/browser.mjs';
import { extract, inspect, render, diffImages } from '../scripts/lib/pdf-tools.mjs';
import { inflateSync } from 'node:zlib';

export { exportInPage, nativePrint, extract, inspect, render, diffImages };

export async function open(page, path) {
  await page.goto(path);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await page.evaluate(() => document.fonts.ready);
}

/** Every text item with page index; pdf.js coordinates in pt (y from top, at baseline). */
export function flatItems(pages) {
  return pages.flatMap((p, pi) => p.items.map((it) => ({ ...it, page: pi })));
}

/** First occurrence page/y of every token matching re. */
export function tokens(pages, re) {
  const out = [];
  pages.forEach((p, pi) => {
    for (const it of p.items) for (const m of it.str.match(re) ?? []) out.push({ tok: m, page: pi, x: it.x, y: it.y, w: it.w, str: it.str });
  });
  return out;
}

/** Decompressed content streams and image dictionaries of a zedpdf file (simple object scan). */
export function pdfObjects(bytes) {
  const s = Buffer.from(bytes).toString('latin1');
  const objs = [];
  const re = /(\d+) 0 obj\n([\s\S]*?)\nendobj/g;
  let m;
  while ((m = re.exec(s))) {
    const body = m[2];
    const dictEnd = body.indexOf('stream\n');
    const dict = dictEnd >= 0 ? body.slice(0, dictEnd) : body;
    let data = null;
    if (dictEnd >= 0) {
      const start = m.index + m[0].indexOf('stream\n') + 7;
      const len = +/\/Length (\d+)/.exec(dict)[1];
      const raw = Buffer.from(bytes).subarray(start, start + len);
      data = /FlateDecode/.test(dict) && !/Subtype \/Image/.test(dict) ? inflateSync(raw) : raw;
    }
    objs.push({ id: +m[1], dict, data });
  }
  return objs;
}
