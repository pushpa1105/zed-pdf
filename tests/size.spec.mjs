// PDF size: oversized images are downsampled, and size optimizations render identically in two
// independent renderers (MuPDF in Node, pdf.js in the browser).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { open, exportInPage, render, diffImages, pdfObjects } from './helpers.mjs';

async function addBigImages(page) {
  // A 3000×2000 noisy JPEG (~1–2 MB) and a 2000×2000 RGBA PNG, both shown small.
  return page.evaluate(async () => {
    const mk = (w, h, alpha) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d');
      const d = x.createImageData(w, h);
      let s = 7;
      for (let i = 0; i < d.data.length; i += 4) {
        s = (s * 1103515245 + 12345) >>> 0;
        d.data[i] = (i / 4) % w / w * 255;
        d.data[i + 1] = s & 255;
        d.data[i + 2] = ((i / 4 / w) / h) * 255;
        d.data[i + 3] = alpha ? (((i / 4) % w) < w / 2 ? 255 : 90) : 255;
      }
      x.putImageData(d, 0, 0);
      return c;
    };
    const blob = (c, type) => new Promise((r) => c.toBlob(r, type, 0.95));
    const jpg = await blob(mk(3000, 2000, false), 'image/jpeg');
    const png = await blob(mk(2000, 2000, true), 'image/png');
    const host = document.createElement('div');
    host.id = 'big';
    host.style.cssText = 'width:600px;font:14px sans-serif;background:#fff';
    host.innerHTML = `<p>Photo</p><img id="j" style="width:240px;height:160px;display:block"><p>PNG</p><img id="p" style="width:120px;height:120px;display:block">`;
    document.body.prepend(host);
    host.querySelector('#j').src = URL.createObjectURL(jpg);
    host.querySelector('#p').src = URL.createObjectURL(png);
    await Promise.all([...host.querySelectorAll('img')].map((i) => i.decode()));
    return { jpg: jpg.size, png: png.size };
  });
}

test('oversized photos are downsampled to maxImageDpi and stay visible', async ({ page }) => {
  await open(page, '/fixtures/boundary.html?case=exact');
  const src = await addBigImages(page);
  expect(src.jpg).toBeGreaterThan(500_000);
  const small = await exportInPage(page, '#big', { margin: 0 });
  const full = await exportInPage(page, '#big', { margin: 0, maxImageDpi: false });
  const ds = small.warnings.filter((w) => w.code === 'image-downsampled');
  expect(ds.length).toBe(2);
  expect(ds.some((w) => /3000×2000 to 750×500/.test(w.message))).toBe(true); // 240 CSS px at 300 dpi
  expect(ds.some((w) => /2000×2000 to 375×375/.test(w.message))).toBe(true); // 120 CSS px at 300 dpi
  expect(small.bytes.length).toBeLessThan(full.bytes.length / 5);
  expect(small.bytes.length).toBeLessThan(250_000);
  // Downsampled images keep their kind: JPEG stays DCT, PNG keeps transparency (SMask).
  const imgs = pdfObjects(small.bytes).filter((o) => /Subtype \/Image/.test(o.dict));
  expect(imgs.some((o) => /DCTDecode/.test(o.dict) && /Width 750/.test(o.dict))).toBe(true);
  expect(imgs.some((o) => /SMask/.test(o.dict) && /Width 375/.test(o.dict))).toBe(true);
  // Both images are drawn (not blank) at their CSS position.
  const r = render(small.bytes, 72)[0];
  const at = (x, y) => r.rgba.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 3);
  expect([...at(Math.round(120 * 0.75), Math.round(60 * 0.75))].some((v) => v < 240)).toBe(true);
});

test('a JPEG that is not oversized is embedded byte-for-byte (no needless recompression)', async ({ page }) => {
  // product.jpg (400×300) drawn 800px wide: below 300 dpi, so the original bytes are kept.
  await open(page, '/fixtures/boundary.html?case=big-image');
  const r = await exportInPage(page, '#doc', { format: { width: '800px', height: '1000px' }, margin: 0 });
  expect(r.warnings.some((w) => w.code === 'image-downsampled')).toBe(false);
  const jpeg = readFileSync('fixtures/assets/product.jpg');
  const dct = pdfObjects(r.bytes).find((o) => /DCTDecode/.test(o.dict));
  expect(Buffer.compare(dct.data, jpeg)).toBe(0);
});

test('MuPDF and pdf.js render the optimized output identically', async ({ page }) => {
  for (const [q, opts] of [['preset=two-page', {}], ['preset=bilingual', { complexScriptFallback: 'raster' }]]) {
    await open(page, `/fixtures/invoice.html?${q}`);
    const r = await exportInPage(page, '#invoice', opts);
    const mu = render(r.bytes, 96)[0];
    const b64 = r.bytes.toString('base64');
    const pngB64 = await page.evaluate(async (b64) => {
      const pdfjs = await import('/node_modules/pdfjs-dist/build/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const doc = await pdfjs.getDocument({ data }).promise;
      const pg = await doc.getPage(1);
      const vp = pg.getViewport({ scale: 96 / 72 });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      return c.toDataURL('image/png').split(',')[1];
    }, b64);
    const pj = PNG.sync.read(Buffer.from(pngB64, 'base64'));
    const d = diffImages(mu, { width: pj.width, height: pj.height, rgba: pj.data });
    expect(d.ratio, q).toBeLessThan(0.02);
  }
});
