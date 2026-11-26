/**
 * Image assets, sized for the page rather than for the original file.
 *
 * - An image is embedded at most at `maxImageDpi` (default 300) for the largest size it is drawn at.
 *   Larger sources (e.g. a 4000×3000 photo used as a 48px thumbnail) are downsampled first.
 * - JPEG and PNG bytes are embedded unchanged when they are already small enough
 *   (no needless recompression). Downsampled opaque photos are re-encoded as JPEG (`jpegQuality`);
 *   images with transparency and graphics stay lossless (PNG-filtered Flate + soft mask).
 * - Inline SVG, <canvas> and complex-script words are rasterized with the browser at `rasterScale`.
 * - Identical sources are embedded once (same URL, same inline SVG markup, same shaped word).
 */
import type { AssetRequest } from '../layout/walk.js';
import { jpegToPdf, parseJpeg, parsePng, pngToPdf, rgbaToPdf, solidWithAlpha, sniffImage, type PdfImageData } from './codecs.js';
import type { AssetResolver } from '../types.js';
import { blobToBytes, withTimeout, type Warnings } from '../util.js';

export interface ImageLoadOptions {
  resolver?: AssetResolver;
  timeout: number;
  rasterScale: number;
  /** Max effective resolution; false keeps every source at its original resolution. */
  maxImageDpi: number | false;
  jpegQuality: number;
  signal?: AbortSignal;
}

/** Sources more than this factor above the target resolution are downsampled. */
const DOWNSAMPLE_SLACK = 1.25;

export async function loadAssets(assets: AssetRequest[], doc: Document, o: ImageLoadOptions, warn: Warnings): Promise<(PdfImageData | null)[]> {
  const out: (PdfImageData | null)[] = new Array(assets.length).fill(null);
  const svgCache = new Map<string, Promise<PdfImageData | null>>();
  let next = 0;
  const worker = async () => {
    while (next < assets.length) {
      const i = next++;
      if (o.signal?.aborted) return;
      try {
        out[i] = await loadOne(assets[i], doc, o, warn, svgCache);
      } catch (e) {
        const a = assets[i];
        warn.add('asset-unavailable', 'warning', `Image could not be embedded (${(e as Error).message})${a.kind === 'url' ? ': ' + a.src : ''}`, a.kind === 'word' ? null : (a.el as Element | null), 'Provide the bytes with options.assetResolver');
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}

async function loadOne(a: AssetRequest, doc: Document, o: ImageLoadOptions, warn: Warnings, svgCache: Map<string, Promise<PdfImageData | null>>): Promise<PdfImageData | null> {
  if (a.kind === 'url') return loadUrl(a, doc, o, warn);
  if (a.kind === 'element') {
    if (a.el.localName === 'canvas') {
      const c = a.el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx || !c.width || !c.height) return null;
      const t = target(c.width, c.height, a, o);
      return encodeCanvas(doc, c, t.w, t.h, false, o);
    }
    warn.add('svg-rasterized', 'info', `Inline SVG embedded as a ${Math.round(96 * o.rasterScale)} dpi raster`, a.el);
    // Key on the serialized markup WITH computed styles: identical icons that inherit different
    // colours (currentColor) must not share a raster.
    const xml = svgMarkup(doc, a.el as SVGSVGElement, a.w, a.h);
    const key = `${xml}|${a.w.toFixed(2)}|${a.h.toFixed(2)}`;
    let p = svgCache.get(key);
    if (!p) svgCache.set(key, (p = rasterSvg(doc, xml, a.w, a.h, o)));
    return p;
  }
  return rasterWord(doc, a, o);
}

/** Pixel size needed to draw a source at `a` CSS px within maxImageDpi. */
function target(nw: number, nh: number, a: { w: number; h: number }, o: ImageLoadOptions): { w: number; h: number; scale: number } {
  if (o.maxImageDpi === false || !nw || !nh) return { w: nw, h: nh, scale: 1 };
  const k = o.maxImageDpi / 96;
  const s = Math.max((a.w * k) / nw, (a.h * k) / nh);
  if (s * DOWNSAMPLE_SLACK >= 1) return { w: nw, h: nh, scale: 1 };
  return { w: Math.max(1, Math.round(nw * s)), h: Math.max(1, Math.round(nh * s)), scale: s };
}

async function loadUrl(a: Extract<AssetRequest, { kind: 'url' }>, doc: Document, o: ImageLoadOptions, warn: Warnings): Promise<PdfImageData | null> {
  const bytes = await fetchBytes(a.src, o);
  if (!bytes) {
    if (a.el && a.el.naturalWidth) {
      // Not fetchable (e.g. no CORS) but decoded by the page: try the canvas route.
      const t = target(a.el.naturalWidth, a.el.naturalHeight, a, o);
      return encodeCanvas(doc, a.el, t.w, t.h, false, o);
    }
    warn.add('asset-unavailable', 'warning', `Image could not be read: ${a.src}`, a.el, 'Serve it with CORS headers or provide the bytes with options.assetResolver');
    return null;
  }
  const fmt = sniffImage(bytes);
  let nw = a.el?.naturalWidth ?? 0;
  let nh = a.el?.naturalHeight ?? 0;
  let orientation = 1;
  if (fmt === 'jpeg') {
    const j = parseJpeg(bytes);
    [nw, nh, orientation] = [j.width, j.height, j.orientation];
  } else if (fmt === 'png') {
    const p = parsePng(bytes);
    [nw, nh] = [p.width, p.height];
  }
  const t = target(nw, nh, a, o);

  // Fast paths: already-suitable JPEG/PNG bytes are embedded unchanged.
  if (t.scale === 1 && fmt === 'jpeg' && (orientation === 1 || !a.el)) return jpegToPdf(bytes);
  if (t.scale === 1 && fmt === 'png') {
    const p = await pngToPdf(bytes);
    if (p) return p;
  }
  if (fmt === 'svg') {
    warn.add('image-rasterized', 'info', `SVG image rasterized at ${Math.round(96 * o.rasterScale)} dpi`, a.el);
    const el = a.el ?? (await decodeBytes(doc, bytes));
    return el ? encodeCanvas(doc, el, a.w * o.rasterScale, a.h * o.rasterScale, false, o) : null;
  }
  const el = a.el && a.el.naturalWidth ? a.el : await decodeBytes(doc, bytes);
  if (!el) return null;
  // JPEG/WebP/AVIF sources are photographic: if opaque they are (re-)encoded as JPEG.
  const photo = fmt === 'jpeg' || fmt === 'webp' || fmt === 'avif';
  const res = await encodeCanvas(doc, el, t.w, t.h, photo, o);
  // Never let downsampling make an image bigger than the original file.
  if (t.scale < 1 && size(res) >= bytes.length && orientation === 1) {
    if (fmt === 'jpeg') return jpegToPdf(bytes);
    if (fmt === 'png') {
      const p = await pngToPdf(bytes);
      if (p) return p;
    }
  }
  if (t.scale < 1) {
    warn.add('image-downsampled', 'info', `Image downsampled from ${nw}×${nh} to ${t.w}×${t.h} px for ${o.maxImageDpi} dpi (${kb(bytes.length)} → ${kb(size(res))})`, a.el, 'Set maxImageDpi: false to keep the original resolution');
  } else if (fmt !== 'jpeg' && fmt !== 'png') {
    warn.add('image-rasterized', 'info', `${fmt.toUpperCase()} image embedded as a raster`, a.el);
  }
  return res;
}

function kb(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function size(p: PdfImageData): number {
  return p.data.length + (p.smask?.data.length ?? 0);
}

async function fetchBytes(url: string, o: ImageLoadOptions): Promise<Uint8Array | null> {
  try {
    if (o.resolver) {
      const r = await o.resolver(url, 'image');
      if (r) return blobToBytes(r as Blob);
    }
    const res = await withTimeout(fetch(url, { signal: o.signal }), o.timeout, null);
    if (!res || !res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function decodeBytes(doc: Document, bytes: Uint8Array): Promise<HTMLImageElement | null> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  try {
    const img = doc.createElement('img');
    img.src = url;
    await img.decode();
    return img;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvas(doc: Document, w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = doc.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

/**
 * Draw a source at w×h (high-quality resampling) and encode it: JPEG when it is a photo without
 * transparency, otherwise lossless PNG-filtered Flate with an optional soft mask.
 */
async function encodeCanvas(doc: Document, src: CanvasImageSource, w: number, h: number, photo: boolean, o: ImageLoadOptions): Promise<PdfImageData> {
  const [c, ctx] = canvas(doc, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height); // throws on a tainted canvas
  if (photo) {
    let opaque = true;
    for (let i = 3; i < d.data.length; i += 4) if (d.data[i] !== 255) { opaque = false; break; }
    if (opaque) {
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', o.jpegQuality));
      if (blob) return jpegToPdf(new Uint8Array(await blob.arrayBuffer()));
    }
  }
  return rgbaToPdf(c.width, c.height, d.data);
}

const SVG_STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'color', 'font-family', 'font-size', 'font-weight', 'display', 'visibility'];

function svgMarkup(doc: Document, svg: SVGSVGElement, w: number, h: number): string {
  // Inline computed presentation styles so CSS-styled icons (fill: currentColor, classes) keep their look.
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const win = doc.defaultView!;
  const src = [svg, ...Array.from(svg.querySelectorAll('*'))];
  const dst = [copy, ...Array.from(copy.querySelectorAll('*'))];
  src.forEach((s, i) => {
    const cs = win.getComputedStyle(s);
    const d = dst[i] as SVGElement;
    for (const p of SVG_STYLE_PROPS) d.style.setProperty(p, cs.getPropertyValue(p));
  });
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(w));
  copy.setAttribute('height', String(h));
  return new XMLSerializer().serializeToString(copy);
}

async function rasterSvg(doc: Document, xml: string, w: number, h: number, o: ImageLoadOptions): Promise<PdfImageData | null> {
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
  try {
    const img = doc.createElement('img');
    img.src = url;
    await withTimeout(img.decode(), o.timeout, undefined);
    if (!img.naturalWidth && !img.width) return null;
    return encodeCanvas(doc, img, w * o.rasterScale, h * o.rasterScale, false, o);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Complex-script fallback: the browser shapes and draws the word at rasterScale. Text is one colour,
 * so it is stored as a 1×1 colour image with a full-resolution soft mask (about a quarter of the
 * bytes of RGB + mask). Identical words (same text, font, size and colour) share one image.
 */
async function rasterWord(doc: Document, a: Extract<AssetRequest, { kind: 'word' }>, o: ImageLoadOptions): Promise<PdfImageData> {
  const { font, color, letterSpacing: ls } = a.item;
  const baselineOff = a.item.baseline - a.item.top;
  const padX = font.size * 0.5;
  const padY = font.size * 0.5;
  const s = o.rasterScale;
  const [c, ctx] = canvas(doc, (a.w + padX * 2) * s, (a.h + padY * 2) * s);
  ctx.scale(s, s);
  ctx.font = `${font.style} ${font.weight} ${font.size}px ${font.family}`;
  if (ls && 'letterSpacing' in ctx) (ctx as any).letterSpacing = `${ls}px`;
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(a.word.text, padX, padY + baselineOff);
  for (const u of [{ item: a.item, word: a.word }, ...a.also]) {
    u.word.rasterRect = { x: u.word.x - padX, y: u.item.top - padY, w: c.width / s, h: c.height / s };
  }
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return solidWithAlpha(c.width, c.height, d.data, [Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255)]);
}
