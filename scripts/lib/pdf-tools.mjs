// Independent PDF validation, text extraction and rendering for tests and reports.
//  - MuPDF (WASM, Artifex) opens/renders the file and reports whether it had to repair it.
//  - pdf.js (Mozilla) parses the file independently and extracts text with positions.
//  - A strict xref check verifies every in-use offset points at "N 0 obj".
// These are development dependencies only.
import * as mupdf from 'mupdf';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export function xrefCheck(bytes) {
  const buf = Buffer.from(bytes);
  const tail = buf.subarray(Math.max(0, buf.length - 1024)).toString('latin1');
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!m) return { ok: false, error: 'no startxref/%%EOF trailer' };
  const xo = +m[1];
  const head = buf.subarray(xo, xo + 32).toString('latin1');
  if (!head.startsWith('xref')) return { ok: false, error: `startxref ${xo} does not point at 'xref' (cross-reference streams not used by zedpdf)` };
  const lines = buf.subarray(xo).toString('latin1').split(/\r?\n/);
  const [first, count] = lines[1].trim().split(/\s+/).map(Number);
  const errors = [];
  let entryBytesOk = true;
  const sectionStart = xo + lines[0].length + 1 + lines[1].length + 1;
  for (let i = 0; i < count; i++) {
    const raw = buf.subarray(sectionStart + i * 20, sectionStart + (i + 1) * 20).toString('latin1');
    if (raw.length !== 20 || !/^\d{10} \d{5} [nf](\r\n| \n| \r)$/.test(raw)) entryBytesOk = false;
    const [off, gen, type] = raw.trim().split(/\s+/);
    if (type !== 'n') continue;
    const id = first + i;
    const at = buf.subarray(+off, +off + 20).toString('latin1');
    if (!at.startsWith(`${id} ${+gen} obj`)) errors.push(`object ${id}: offset ${off} points at '${at.slice(0, 12)}'`);
  }
  return { ok: errors.length === 0 && entryBytesOk, objects: count, entryBytesOk, errors: errors.slice(0, 5) };
}

export async function inspect(bytes) {
  const data = new Uint8Array(bytes);
  const md = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = md.asPDF?.();
  const repaired = pdfDoc ? pdfDoc.wasRepaired() : null;
  const mupdfPages = md.countPages();
  const sizes = [];
  for (let i = 0; i < mupdfPages; i++) {
    const b = md.loadPage(i).getBounds();
    sizes.push([+(b[2] - b[0]).toFixed(2), +(b[3] - b[1]).toFixed(2)]);
  }
  const pj = await getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false }).promise;
  return { mupdfPages, mupdfRepaired: repaired, pdfjsPages: pj.numPages, sizes, xref: xrefCheck(bytes) };
}

/** Text items per page with positions (PDF points, origin top-left). */
export async function extract(bytes) {
  const pj = await getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= pj.numPages; p++) {
    const page = await pj.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((i) => 'str' in i)
      .map((i) => ({ str: i.str, x: i.transform[4], y: vp.height - i.transform[5], w: i.width, h: i.height, eol: i.hasEOL }));
    let text = '';
    for (const it of items) text += it.str + (it.eol ? '\n' : '');
    pages.push({ items, text, width: vp.width, height: vp.height });
  }
  return pages;
}

/** Render every page with MuPDF. Returns [{png: Buffer, width, height, rgba: Buffer}] */
export function render(bytes, dpi = 96) {
  const md = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  const out = [];
  const s = dpi / 72;
  for (let i = 0; i < md.countPages(); i++) {
    const pix = md.loadPage(i).toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
    const w = pix.getWidth();
    const h = pix.getHeight();
    const px = pix.getPixels();
    const rgba = Buffer.alloc(w * h * 4);
    for (let k = 0, j = 0; k < w * h; k++) {
      rgba[k * 4] = px[j++];
      rgba[k * 4 + 1] = px[j++];
      rgba[k * 4 + 2] = px[j++];
      rgba[k * 4 + 3] = 255;
    }
    out.push({ png: Buffer.from(pix.asPNG()), width: w, height: h, rgba });
  }
  return out;
}

/** Pixel diff of two renders (same size). Returns mismatch ratio and a diff PNG. */
export function diffImages(a, b, threshold = 0.15) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const crop = (img) => {
    if (img.width === w && img.height === h) return img.rgba;
    const o = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) img.rgba.copy(o, y * w * 4, y * img.width * 4, y * img.width * 4 + w * 4);
    return o;
  };
  const diff = new PNG({ width: w, height: h });
  const n = pixelmatch(crop(a), crop(b), diff.data, w, h, { threshold, includeAA: false });
  return { mismatched: n, ratio: n / (w * h), png: PNG.sync.write(diff) };
}

/** Ink bounding box (non-white pixels) of a render, in px. */
export function inkBox(img, thr = 245) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const k = (y * img.width + x) * 4;
      if (img.rgba[k] < thr || img.rgba[k + 1] < thr || img.rgba[k + 2] < thr) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}
