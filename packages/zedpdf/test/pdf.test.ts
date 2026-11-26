import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { PdfWriter, num, pdfTextString, inflate } from '../src/pdf/writer';
import { parseFontBytes, subsetTrueType, parseSfnt } from '../src/font/sfnt';
import { toUnicodeCMap, winAnsi } from '../src/font/fonts';
import { pngToPdf, parseJpeg, sniffImage } from '../src/image/codecs';
import { pageModel, lengthToPx } from '../src/page';
import { rewriteMedia, absolutizeUrls } from '../src/layout/surface';

const fixture = (p: string) => new Uint8Array(readFileSync(new URL(`../../../fixtures/assets/${p}`, import.meta.url)));
const latin = (b: Uint8Array) => Buffer.from(b).toString('latin1');

/** Undo PNG row filters (what a PDF reader does for /Predictor 15). */
function unpng(d: Uint8Array, width: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const rows = d.length / (stride + 1);
  const out = new Uint8Array(rows * stride);
  for (let y = 0; y < rows; y++) {
    const ft = d[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const raw = d[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = y && x >= bpp ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[y * stride + x] = (raw + [0, a, b, (a + b) >> 1, pr][ft]) & 0xff;
    }
  }
  return out;
}

describe('PDF writer', () => {
  it('computes xref offsets from bytes (binary-safe, multi-byte content)', async () => {
    const w = new PdfWriter();
    const pages = w.alloc();
    const content = await w.addStream('', new TextEncoder().encode('BT /F1 12 Tf (Ünïcödé €) Tj ET'.repeat(20)));
    const bin = await w.addStream('/Type /XObject', new Uint8Array([0, 255, 13, 10, 128, 37, 37, 69, 79, 70]), false);
    const page = w.add(`<< /Type /Page /Parent ${pages} /MediaBox [0 0 100 100] /Contents ${content} /Resources << >> >>`);
    w.set(pages, `<< /Type /Pages /Kids [${page}] /Count 1 >>`);
    const cat = w.add(`<< /Type /Catalog /Pages ${pages} /X ${bin} >>`);
    const bytes = w.finish(cat);
    const s = latin(bytes);
    expect(s.startsWith('%PDF-1.7\n%')).toBe(true);
    expect(bytes[10]).toBeGreaterThan(127); // binary marker line
    const xo = +/startxref\n(\d+)\n%%EOF\n$/.exec(s)![1];
    expect(s.slice(xo, xo + 4)).toBe('xref');
    const lines = s.slice(xo).split('\n');
    const count = +lines[1].split(' ')[1];
    const entries = s.slice(xo + lines[0].length + lines[1].length + 2).slice(0, count * 20);
    for (let i = 1; i < count; i++) {
      const e = entries.slice(i * 20, (i + 1) * 20);
      expect(e).toMatch(/^\d{10} 00000 n\r\n$/);
      const off = +e.slice(0, 10);
      expect(s.slice(off, off + `${i} 0 obj`.length)).toBe(`${i} 0 obj`);
    }
    // The compressed stream round-trips.
    const m = /stream\n/.exec(s.slice(s.indexOf(`${content.id} 0 obj`)))!;
    const start = s.indexOf(`${content.id} 0 obj`) + m.index + 7;
    const len = +/\/Length (\d+)/.exec(s.slice(s.indexOf(`${content.id} 0 obj`)))![1];
    const decoded = new TextDecoder().decode(await inflate(bytes.subarray(start, start + len)));
    expect(decoded.startsWith('BT /F1 12 Tf (Ünïcödé €)')).toBe(true);
  });

  it('formats numbers without exponents and keeps precision until serialization', () => {
    expect(num(1e-7)).toBe('0');
    expect(num(595.2755905511812)).toBe('595.28');
    expect(num(595.2755905511812, 3)).toBe('595.276');
    expect(num(-0.0001)).toBe('0');
    expect(num(12)).toBe('12');
    expect(pdfTextString('Invoice (draft)')).toBe('(Invoice \\(draft\\))');
    expect(pdfTextString('नेपाली')).toMatch(/^<FEFF/);
  });
});

describe('fonts', () => {
  it('parses Noto Sans: metrics, cmap and embedding permission', async () => {
    const f = await parseFontBytes(fixture('fonts/NotoSans_400Regular.ttf'));
    expect(f.unitsPerEm).toBe(1000);
    expect(f.isCFF).toBe(false);
    for (const ch of 'AZaz09€₹−—“') expect(f.glyphForCodePoint(ch.codePointAt(0)!), ch).toBeGreaterThan(0);
    expect(f.advances[f.glyphForCodePoint(65)]).toBeGreaterThan(500);
    expect(f.postscriptName).toBe('NotoSans-Regular');
  });

  it('subsets glyf with stable glyph ids and drops cmap (ISO 32000-1 §9.9)', async () => {
    const f = await parseFontBytes(fixture('fonts/NotoSans_400Regular.ttf'));
    const used = new Set([...'Invoice'].map((c) => f.glyphForCodePoint(c.codePointAt(0)!)));
    const sub = subsetTrueType(f, used);
    expect(sub.length).toBeLessThan(f.bytes.length / 5);
    const g = parseSfnt(sub);
    expect(g.numGlyphs).toBe(f.numGlyphs);
    expect(g.tables.has('cmap')).toBe(false);
    for (const gid of used) expect(g.advances[gid]).toBe(f.advances[gid]);
  });

  it('builds a ToUnicode CMap with UTF-16 (incl. surrogates) and WinAnsi mapping', () => {
    const cm = toUnicodeCMap(new Map([[36, 'A'], [900, 'क्ष'], [5, '𝐀']]));
    expect(cm).toContain('<0024> <0041>');
    expect(cm).toContain('<0384> <0915094D0937>');
    expect(cm).toContain('<0005> <D835DC00>');
    expect(winAnsi(0x20ac)).toBe(0x80);
    expect(winAnsi(0x2212)).toBeNull();
  });
});

describe('images', () => {
  it('PNG without alpha passes IDAT through; RGBA splits into colour + SMask', async () => {
    const rgb = new PNG({ width: 3, height: 2, colorType: 2 });
    rgb.data.fill(200);
    const rgbBytes = new Uint8Array(PNG.sync.write(rgb, { colorType: 2 }));
    const a = (await pngToPdf(rgbBytes))!;
    expect(a.dict).toContain('/Predictor 15 /Colors 3');
    expect(a.smask).toBeUndefined();
    const rgba = new PNG({ width: 2, height: 2 });
    rgba.data.set([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255]);
    const b = (await pngToPdf(new Uint8Array(PNG.sync.write(rgba))))!;
    expect(b.smask).toBeTruthy();
    expect(b.smask!.dict).toContain('/Predictor 15');
    const alpha = unpng(await inflate(b.smask!.data), 2, 1);
    expect([...alpha]).toEqual([255, 128, 0, 255]);
    const color = unpng(await inflate(b.data), 2, 3);
    expect([...color.subarray(0, 6)]).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it('reads JPEG headers for DCT passthrough', () => {
    const j = fixture('product.jpg');
    expect(sniffImage(j)).toBe('jpeg');
    const info = parseJpeg(j);
    expect([info.width, info.height, info.components]).toEqual([400, 300, 3]);
  });

  it('the logo fixture is a transparent PNG', async () => {
    const d = (await pngToPdf(fixture('logo.png')))!;
    expect(d.smask).toBeTruthy();
  });
});

describe('page model and media rewriting', () => {
  it('converts lengths and builds A4/Letter in both orientations', () => {
    expect(lengthToPx('25.4mm', 0)).toBeCloseTo(96);
    expect(lengthToPx('72pt', 0)).toBeCloseTo(96);
    const a4 = pageModel({ format: 'A4', margin: '10mm' });
    expect(a4.width * 0.75).toBeCloseTo(595.276, 2);
    expect(a4.contentWidth).toBeCloseTo(793.7 - 75.59, 1);
    const ll = pageModel({ format: 'Letter', orientation: 'landscape', margin: 0 });
    expect(ll.width).toBeCloseTo(1056, 6);
    expect(ll.height).toBeCloseTo(816, 6);
  });

  it('re-targets print media for the iframe (screen) context', () => {
    expect(rewriteMedia('print', 'print')).toBe('all');
    expect(rewriteMedia('screen', 'print')).toBe('not all');
    expect(rewriteMedia('screen and (min-width: 600px), print and (max-width: 900px)', 'print')).toBe('not all, all and (max-width: 900px)');
    expect(rewriteMedia('not print', 'print')).toBe('not all');
    expect(rewriteMedia('(min-width: 600px)', 'print')).toBe('(min-width: 600px)');
    expect(rewriteMedia('print', 'screen')).toBe('print');
    expect(absolutizeUrls('a{background:url(img/x.png)} b{src:url("data:x")}', 'http://h/css/s.css')).toBe('a{background:url("http://h/css/img/x.png")} b{src:url("data:x")}');
  });
});
