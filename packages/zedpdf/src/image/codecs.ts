/**
 * Image codecs for PDF embedding.
 * - JPEG: header parse only; bytes are embedded unchanged with /DCTDecode (no recompression).
 * - PNG: non-interlaced PNG without alpha is passed through (IDAT + Flate /Predictor 15).
 *   PNG with alpha (RGBA, GA, tRNS) is decoded, split into colour + /SMask, and re-deflated.
 */
import { deflate, inflate } from '../pdf/writer.js';

export interface PdfImageData {
  width: number;
  height: number;
  /** PDF image dictionary entries (without /Type /XObject /Subtype /Image /Width /Height /Length). */
  dict: string;
  data: Uint8Array;
  /** True when `data` is already compressed (filter in dict). */
  encoded: boolean;
  /** Soft mask; may have its own (smaller or larger) resolution (ISO 32000-1 §11.6.5.3). */
  smask?: { dict: string; data: Uint8Array; encoded: boolean; width?: number; height?: number };
}

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'svg' | 'bmp' | 'avif' | 'unknown';

export function sniffImage(b: Uint8Array): ImageFormat {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57) return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'avif';
  const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  return 'unknown';
}

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
  bits: number;
  adobe: boolean;
  orientation: number;
}

export function parseJpeg(b: Uint8Array): JpegInfo {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 2;
  let adobe = false;
  let orientation = 1;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = b[p + 1];
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    const len = dv.getUint16(p + 2);
    if (marker === 0xee && String.fromCharCode(...b.subarray(p + 4, p + 9)) === 'Adobe') adobe = true;
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(p + 4, p + 8)) === 'Exif') {
      orientation = readExifOrientation(dv, p + 10) ?? 1;
    }
    // SOF0..SOF15 except DHT(c4), JPG(c8), DAC(cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        bits: b[p + 4],
        height: dv.getUint16(p + 5),
        width: dv.getUint16(p + 7),
        components: b[p + 9],
        adobe,
        orientation,
      };
    }
    p += 2 + len;
  }
  throw new Error('Invalid JPEG: no SOF marker');
}

function readExifOrientation(dv: DataView, tiff: number): number | null {
  try {
    const le = dv.getUint16(tiff) === 0x4949;
    const ifd = tiff + dv.getUint32(tiff + 4, le);
    const n = dv.getUint16(ifd, le);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (dv.getUint16(e, le) === 0x0112) return dv.getUint16(e + 8, le);
    }
  } catch {
    /* ignore malformed EXIF */
  }
  return null;
}

export function jpegToPdf(b: Uint8Array): PdfImageData {
  const j = parseJpeg(b);
  const cs = j.components === 1 ? '/DeviceGray' : j.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
  // Adobe-APP14 CMYK JPEGs are stored inverted.
  const decode = j.components === 4 && j.adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
  return {
    width: j.width,
    height: j.height,
    dict: `/ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${decode}`,
    data: b,
    encoded: true,
  };
}

interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  palette?: Uint8Array;
  trns?: Uint8Array;
  idat: Uint8Array;
}

export function parsePng(b: Uint8Array): PngInfo {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  const idats: Uint8Array[] = [];
  let info: Partial<PngInfo> = {};
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      info = {
        width: dv.getUint32(p + 8),
        height: dv.getUint32(p + 12),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') info.palette = data;
    else if (type === 'tRNS') info.trns = data;
    else if (type === 'IDAT') idats.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!info.width) throw new Error('Invalid PNG: no IHDR');
  let total = 0;
  for (const d of idats) total += d.length;
  const idat = new Uint8Array(total);
  let o = 0;
  for (const d of idats) {
    idat.set(d, o);
    o += d.length;
  }
  return { ...(info as PngInfo), idat };
}

/** Returns null when the PNG needs the canvas fallback (interlaced). */
export async function pngToPdf(b: Uint8Array): Promise<PdfImageData | null> {
  const png = parsePng(b);
  const { width, height, bitDepth, colorType } = png;
  if (png.interlace) return null;
  const hasAlpha = colorType === 4 || colorType === 6 || !!png.trns;

  if (!hasAlpha) {
    // Pass-through: the zlib stream with PNG row filters is exactly FlateDecode + Predictor 15.
    const colors = colorType === 2 ? 3 : 1;
    let cs = colorType === 2 ? '/DeviceRGB' : '/DeviceGray';
    if (colorType === 3) cs = `[/Indexed /DeviceRGB ${png.palette!.length / 3 - 1} <${hex(png.palette!)}>]`;
    return {
      width,
      height,
      dict: `/ColorSpace ${cs} /BitsPerComponent ${bitDepth} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${bitDepth} /Columns ${width} >>`,
      data: png.idat,
      encoded: true,
    };
  }

  // Decode, then split colour and alpha (8-bit each).
  const raw = await inflate(png.idat);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType as 0 | 2 | 3 | 4 | 6];
  const bpp = Math.max(1, (channels * bitDepth) >> 3);
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const px = unfilter(raw, height, stride, bpp);
  const isGray = colorType === 0 || colorType === 4;
  const colorN = isGray ? 1 : 3;
  const color = new Uint8Array(width * height * colorN);
  const alpha = new Uint8Array(width * height);
  const sample = (row: Uint8Array, idx: number): number => {
    // idx = sample index within row
    if (bitDepth === 8) return row[idx];
    if (bitDepth === 16) return row[idx * 2];
    const perByte = 8 / bitDepth;
    const byte = row[Math.floor(idx / perByte)];
    const shift = 8 - bitDepth * ((idx % perByte) + 1);
    return (byte >> shift) & ((1 << bitDepth) - 1);
  };
  const scale = bitDepth < 8 && colorType !== 3 ? 255 / ((1 << bitDepth) - 1) : 1;
  const trns = png.trns;
  const trnsKey = (k: number) => (trns ? (trns[k * 2] << 8) | trns[k * 2 + 1] : -1);
  for (let y = 0; y < height; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (colorType === 3) {
        const idx = sample(row, x);
        color[i * 3] = png.palette![idx * 3];
        color[i * 3 + 1] = png.palette![idx * 3 + 1];
        color[i * 3 + 2] = png.palette![idx * 3 + 2];
        alpha[i] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0) {
        const v = sample(row, x);
        color[i] = Math.round(v * scale);
        const raw16 = bitDepth === 16 ? (row[x * 2] << 8) | row[x * 2 + 1] : v;
        alpha[i] = trns && raw16 === trnsKey(0) ? 0 : 255;
      } else if (colorType === 2) {
        const r = sample(row, x * 3);
        const g = sample(row, x * 3 + 1);
        const bl = sample(row, x * 3 + 2);
        color[i * 3] = r;
        color[i * 3 + 1] = g;
        color[i * 3 + 2] = bl;
        let transparent = false;
        if (trns) {
          if (bitDepth === 16) {
            const o = x * 6;
            transparent =
              ((row[o] << 8) | row[o + 1]) === trnsKey(0) &&
              ((row[o + 2] << 8) | row[o + 3]) === trnsKey(1) &&
              ((row[o + 4] << 8) | row[o + 5]) === trnsKey(2);
          } else transparent = r === trnsKey(0) && g === trnsKey(1) && bl === trnsKey(2);
        }
        alpha[i] = transparent ? 0 : 255;
      } else if (colorType === 4) {
        color[i] = sample(row, x * 2);
        alpha[i] = sample(row, x * 2 + 1);
      } else {
        color[i * 3] = sample(row, x * 4);
        color[i * 3 + 1] = sample(row, x * 4 + 1);
        color[i * 3 + 2] = sample(row, x * 4 + 2);
        alpha[i] = sample(row, x * 4 + 3);
      }
    }
  }
  return rgbaPartsToPdf(width, height, color, isGray, alpha);
}

export async function rgbaPartsToPdf(
  width: number,
  height: number,
  color: Uint8Array,
  isGray: boolean,
  alpha: Uint8Array | null,
): Promise<PdfImageData> {
  let opaque = true;
  if (alpha) for (let i = 0; i < alpha.length; i++) if (alpha[i] !== 255) { opaque = false; break; }
  const img: PdfImageData = {
    width,
    height,
    dict: `/ColorSpace ${isGray ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent 8 ${flateParams(isGray ? 1 : 3, width)}`,
    data: await flateImage(color, width, height, isGray ? 1 : 3),
    encoded: true,
  };
  if (alpha && !opaque) {
    img.smask = {
      dict: `/ColorSpace /DeviceGray /BitsPerComponent 8 ${flateParams(1, width)}`,
      data: await flateImage(alpha, width, height, 1),
      encoded: true,
    };
  }
  return img;
}

function flateParams(colors: number, columns: number): string {
  return `/Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${columns} >>`;
}

/**
 * Deflate 8-bit samples with per-row PNG filters (chosen by the minimum-sum-of-absolute-differences
 * heuristic). Readers undo them via /DecodeParms /Predictor 15. Typically 30-60 % smaller than plain
 * Flate for logos, screenshots and masks.
 */
export async function flateImage(data: Uint8Array, width: number, height: number, bpp: number): Promise<Uint8Array> {
  const stride = width * bpp;
  const out = new Uint8Array(height * (stride + 1));
  const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev ? prev[x] : 0;
        const cc = prev && x >= bpp ? prev[x - bpp] : 0;
        let p: number;
        if (f === 0) p = 0;
        else if (f === 1) p = a;
        else if (f === 2) p = b;
        else if (f === 3) p = (a + b) >> 1;
        else {
          const q = a + b - cc;
          const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - cc);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
        }
        const v = (row[x] - p) & 0xff;
        c[x] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    // Recompute the chosen filter fully (the loop above may have stopped early).
    const o = y * (stride + 1);
    out[o] = best;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const cc = prev && x >= bpp ? prev[x - bpp] : 0;
      let p = 0;
      if (best === 1) p = a;
      else if (best === 2) p = b;
      else if (best === 3) p = (a + b) >> 1;
      else if (best === 4) {
        const q = a + b - cc;
        const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - cc);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
      }
      out[o + 1 + x] = (row[x] - p) & 0xff;
    }
  }
  return deflate(out);
}

/**
 * A single-colour shape with antialiased edges (e.g. a rasterized word): a 1×1 colour image plus a
 * full-resolution soft mask. The mask carries all detail, so this is ~1/4 the size of RGB + mask.
 */
export async function solidWithAlpha(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array, rgb: [number, number, number]): Promise<PdfImageData> {
  const n = width * height;
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = rgba[i * 4 + 3];
  return {
    width: 1,
    height: 1,
    dict: '/ColorSpace /DeviceRGB /BitsPerComponent 8',
    data: new Uint8Array(rgb),
    encoded: false,
    smask: { dict: `/ColorSpace /DeviceGray /BitsPerComponent 8 ${flateParams(1, width)}`, data: await flateImage(alpha, width, height, 1), encoded: true, width, height },
  };
}

/** RGBA (straight alpha, as from ImageData) to PDF image + SMask. */
export async function rgbaToPdf(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array): Promise<PdfImageData> {
  const n = width * height;
  const color = new Uint8Array(n * 3);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    color[i * 3] = rgba[i * 4];
    color[i * 3 + 1] = rgba[i * 4 + 1];
    color[i * 3 + 2] = rgba[i * 4 + 2];
    alpha[i] = rgba[i * 4 + 3];
  }
  return rgbaPartsToPdf(width, height, color, false, alpha);
}

function unfilter(raw: Uint8Array, height: number, stride: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (ft) {
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
      }
      cur[x] = v & 0xff;
    }
    prev = cur;
  }
  return out;
}

function hex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
