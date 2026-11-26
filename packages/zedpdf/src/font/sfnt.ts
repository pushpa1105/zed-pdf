/**
 * TrueType / OpenType (sfnt) reader for embedding: tables, cmap lookup, metrics, embedding
 * permissions and a glyph-preserving subsetter. WOFF 1.0 is unwrapped with DecompressionStream.
 * WOFF2 needs Brotli plus glyf/loca reconstruction and is reported as unsupported.
 */
import { inflate } from '../pdf/writer.js';

export interface SfntTable {
  tag: string;
  offset: number;
  length: number;
}

export class FontFormatError extends Error {}

export interface ParsedFont {
  bytes: Uint8Array;
  tables: Map<string, SfntTable>;
  isCFF: boolean;
  unitsPerEm: number;
  numGlyphs: number;
  ascender: number; // hhea
  descender: number; // hhea (negative)
  lineGap: number;
  typoAscender: number;
  typoDescender: number;
  winAscent: number;
  winDescent: number;
  capHeight: number;
  bbox: [number, number, number, number];
  italicAngle: number;
  underlinePosition: number;
  underlineThickness: number;
  isFixedPitch: boolean;
  /** OS/2 fsType embedding bits. */
  fsType: number;
  postscriptName: string;
  familyName: string;
  isVariable: boolean;
  advances: Uint16Array;
  glyphForCodePoint(cp: number): number;
}

export async function parseFontBytes(input: Uint8Array): Promise<ParsedFont> {
  const sig = tagAt(input, 0);
  let bytes = input;
  if (sig === 'wOFF') bytes = await unwrapWoff(input);
  else if (sig === 'wOF2') throw new FontFormatError('WOFF2 fonts are not supported yet (needs Brotli); supply a TTF/OTF/WOFF via options.fonts');
  else if (sig === 'ttcf') throw new FontFormatError('TrueType collections (.ttc) are not supported; supply a single TTF/OTF');
  return parseSfnt(bytes);
}

function tagAt(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

async function unwrapWoff(w: Uint8Array): Promise<Uint8Array> {
  const dv = new DataView(w.buffer, w.byteOffset, w.byteLength);
  const flavor = dv.getUint32(4);
  const numTables = dv.getUint16(12);
  const entries: { tag: string; offset: number; compLength: number; origLength: number; checksum: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    entries.push({
      tag: tagAt(w, o),
      offset: dv.getUint32(o + 4),
      compLength: dv.getUint32(o + 8),
      origLength: dv.getUint32(o + 12),
      checksum: dv.getUint32(o + 16),
    });
  }
  const datas: Uint8Array[] = [];
  for (const e of entries) {
    const raw = w.subarray(e.offset, e.offset + e.compLength);
    datas.push(e.compLength < e.origLength ? await inflate(raw) : raw);
  }
  return buildSfnt(
    flavor,
    entries.map((e, i) => ({ tag: e.tag, data: datas[i] })),
  );
}

/** Assemble an sfnt from tables (sorted by tag, 4-byte aligned, checksums computed). */
export function buildSfnt(flavor: number, tables: { tag: string; data: Uint8Array }[]): Uint8Array {
  tables = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const n = tables.length;
  let size = 12 + 16 * n;
  for (const t of tables) size += (t.data.length + 3) & ~3;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, flavor);
  dv.setUint16(4, n);
  let es = 1;
  let log = 0;
  while (es * 2 <= n) {
    es *= 2;
    log++;
  }
  dv.setUint16(6, es * 16);
  dv.setUint16(8, log);
  dv.setUint16(10, n * 16 - es * 16);
  let off = 12 + 16 * n;
  let headOffset = -1;
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[r + k] = t.tag.charCodeAt(k);
    out.set(t.data, off);
    if (t.tag === 'head') {
      headOffset = off;
      dv.setUint32(off + 8, 0); // checksumAdjustment zeroed before checksums
    }
    dv.setUint32(r + 4, checksum(out, off, t.data.length));
    dv.setUint32(r + 8, off);
    dv.setUint32(r + 12, t.data.length);
    off += (t.data.length + 3) & ~3;
  });
  if (headOffset >= 0) dv.setUint32(headOffset + 8, (0xb1b0afba - checksum(out, 0, out.length)) >>> 0);
  return out;
}

function checksum(b: Uint8Array, off: number, len: number): number {
  let sum = 0;
  const end = off + ((len + 3) & ~3);
  for (let i = off; i < end; i += 4) {
    sum = (sum + (((b[i] << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0)) >>> 0;
  }
  return sum;
}

export function parseSfnt(bytes: Uint8Array): ParsedFont {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sfntVersion = dv.getUint32(0);
  if (sfntVersion !== 0x00010000 && sfntVersion !== 0x4f54544f && sfntVersion !== 0x74727565) {
    throw new FontFormatError('Not a TrueType/OpenType font');
  }
  const numTables = dv.getUint16(4);
  const tables = new Map<string, SfntTable>();
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    const tag = tagAt(bytes, o);
    tables.set(tag, { tag, offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) });
  }
  const need = (t: string) => {
    const tb = tables.get(t);
    if (!tb) throw new FontFormatError(`Font is missing required table '${t}'`);
    return tb.offset;
  };
  const head = need('head');
  const unitsPerEm = dv.getUint16(head + 18);
  const bbox: [number, number, number, number] = [
    dv.getInt16(head + 36),
    dv.getInt16(head + 38),
    dv.getInt16(head + 40),
    dv.getInt16(head + 42),
  ];
  const hhea = need('hhea');
  const ascender = dv.getInt16(hhea + 4);
  const descender = dv.getInt16(hhea + 6);
  const lineGap = dv.getInt16(hhea + 8);
  const numberOfHMetrics = dv.getUint16(hhea + 34);
  const maxp = need('maxp');
  const numGlyphs = dv.getUint16(maxp + 4);
  const hmtx = need('hmtx');
  const advances = new Uint16Array(numGlyphs);
  let last = 0;
  for (let g = 0; g < numGlyphs; g++) {
    if (g < numberOfHMetrics) last = dv.getUint16(hmtx + g * 4);
    advances[g] = last;
  }

  let typoAscender = ascender;
  let typoDescender = descender;
  let winAscent = ascender;
  let winDescent = -descender;
  let capHeight = Math.round(ascender * 0.7);
  let fsType = 0;
  const os2 = tables.get('OS/2');
  if (os2) {
    const o = os2.offset;
    const version = dv.getUint16(o);
    fsType = dv.getUint16(o + 8);
    typoAscender = dv.getInt16(o + 68);
    typoDescender = dv.getInt16(o + 70);
    winAscent = dv.getUint16(o + 74);
    winDescent = dv.getUint16(o + 76);
    if (version >= 2 && os2.length >= 90) capHeight = dv.getInt16(o + 88);
  }
  let italicAngle = 0;
  let underlinePosition = -Math.round(unitsPerEm * 0.1);
  let underlineThickness = Math.round(unitsPerEm * 0.05);
  let isFixedPitch = false;
  const post = tables.get('post');
  if (post) {
    italicAngle = dv.getInt32(post.offset + 4) / 65536;
    underlinePosition = dv.getInt16(post.offset + 8);
    underlineThickness = dv.getInt16(post.offset + 10);
    isFixedPitch = dv.getUint32(post.offset + 12) !== 0;
  }
  const names = readNames(bytes, dv, tables.get('name'));
  const lookup = buildCmapLookup(dv, tables.get('cmap'));

  return {
    bytes,
    tables,
    isCFF: tables.has('CFF ') || tables.has('CFF2'),
    unitsPerEm,
    numGlyphs,
    ascender,
    descender,
    lineGap,
    typoAscender,
    typoDescender,
    winAscent,
    winDescent,
    capHeight,
    bbox,
    italicAngle,
    underlinePosition,
    underlineThickness,
    isFixedPitch,
    fsType,
    postscriptName: (names[6] || names[4] || 'EmbeddedFont').replace(/[^A-Za-z0-9-]/g, ''),
    familyName: names[1] || '',
    isVariable: tables.has('fvar'),
    advances,
    glyphForCodePoint: lookup,
  };
}

function readNames(bytes: Uint8Array, dv: DataView, t: SfntTable | undefined): Record<number, string> {
  const out: Record<number, string> = {};
  if (!t) return out;
  const o = t.offset;
  const count = dv.getUint16(o + 2);
  const strOff = o + dv.getUint16(o + 4);
  for (let i = 0; i < count; i++) {
    const r = o + 6 + i * 12;
    const platform = dv.getUint16(r);
    const nameId = dv.getUint16(r + 6);
    const len = dv.getUint16(r + 8);
    const off = strOff + dv.getUint16(r + 10);
    if (out[nameId]) continue;
    if (platform === 3 || platform === 0) {
      let s = '';
      for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(dv.getUint16(off + k));
      out[nameId] = s;
    } else if (platform === 1) {
      let s = '';
      for (let k = 0; k < len; k++) s += String.fromCharCode(bytes[off + k]);
      out[nameId] = s;
    }
  }
  return out;
}

function buildCmapLookup(dv: DataView, t: SfntTable | undefined): (cp: number) => number {
  if (!t) return () => 0;
  const o = t.offset;
  const n = dv.getUint16(o + 2);
  let best: { off: number; fmt: number; score: number } | null = null;
  for (let i = 0; i < n; i++) {
    const r = o + 4 + i * 8;
    const pid = dv.getUint16(r);
    const eid = dv.getUint16(r + 2);
    const sub = o + dv.getUint32(r + 4);
    const fmt = dv.getUint16(sub);
    let score = 0;
    if (fmt === 12 && ((pid === 3 && eid === 10) || pid === 0)) score = 4;
    else if (fmt === 4 && pid === 3 && eid === 1) score = 3;
    else if (fmt === 4 && pid === 0) score = 2;
    else if (fmt === 4 && pid === 3 && eid === 0) score = 1; // symbol
    if (score && (!best || score > best.score)) best = { off: sub, fmt, score };
  }
  if (!best) return () => 0;
  const s = best.off;
  if (best.fmt === 12) {
    const nGroups = dv.getUint32(s + 12);
    const starts = new Uint32Array(nGroups);
    const ends = new Uint32Array(nGroups);
    const gids = new Uint32Array(nGroups);
    for (let i = 0; i < nGroups; i++) {
      const g = s + 16 + i * 12;
      starts[i] = dv.getUint32(g);
      ends[i] = dv.getUint32(g + 4);
      gids[i] = dv.getUint32(g + 8);
    }
    return (cp) => {
      let lo = 0;
      let hi = nGroups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cp < starts[mid]) hi = mid - 1;
        else if (cp > ends[mid]) lo = mid + 1;
        else return gids[mid] + (cp - starts[mid]);
      }
      return 0;
    };
  }
  // format 4
  const segX2 = dv.getUint16(s + 6);
  const segs = segX2 / 2;
  const endO = s + 14;
  const startO = endO + segX2 + 2;
  const deltaO = startO + segX2;
  const rangeO = deltaO + segX2;
  const symbol = best.score === 1;
  return (cpIn) => {
    let cp = cpIn;
    if (cp > 0xffff) return 0;
    for (let pass = 0; pass < (symbol ? 2 : 1); pass++) {
      let lo = 0;
      let hi = segs - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const end = dv.getUint16(endO + mid * 2);
        const start = dv.getUint16(startO + mid * 2);
        if (cp > end) lo = mid + 1;
        else if (cp < start) hi = mid - 1;
        else {
          const delta = dv.getInt16(deltaO + mid * 2);
          const ro = dv.getUint16(rangeO + mid * 2);
          if (ro === 0) return (cp + delta) & 0xffff;
          const gaddr = rangeO + mid * 2 + ro + (cp - start) * 2;
          const g = dv.getUint16(gaddr);
          return g === 0 ? 0 : (g + delta) & 0xffff;
        }
      }
      cp = 0xf000 + (cpIn & 0xff); // symbol fonts map into the PUA
    }
    return 0;
  };
}

/** Whether the font's licensing bits allow embedding for print & preview. */
export function embeddingAllowed(f: ParsedFont): boolean {
  // fsType 0x0002 = Restricted License embedding; bits 0x0004/0x0008 allow preview/print & editable.
  const restricted = (f.fsType & 0x000f) === 0x0002;
  return !restricted;
}

/**
 * Subset a TrueType-outline font keeping glyph IDs stable: glyphs that are not used become empty,
 * loca is rebuilt. Composite glyph components are kept. Unused tables (layout, colour, variations)
 * are dropped. CFF fonts are returned whole.
 */
export function subsetTrueType(f: ParsedFont, used: Set<number>): Uint8Array {
  if (f.isCFF) return f.bytes;
  const dv = new DataView(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
  const headT = f.tables.get('head')!;
  const locaT = f.tables.get('loca');
  const glyfT = f.tables.get('glyf');
  if (!locaT || !glyfT) return f.bytes;
  const longLoca = dv.getInt16(headT.offset + 50) === 1;
  const loc = (g: number) =>
    longLoca ? dv.getUint32(locaT.offset + g * 4) : dv.getUint16(locaT.offset + g * 2) * 2;

  const keep = new Set<number>([0, ...used]);
  // Pull in composite components.
  const stack = [...keep];
  while (stack.length) {
    const g = stack.pop()!;
    if (g >= f.numGlyphs) continue;
    const start = loc(g);
    const end = loc(g + 1);
    if (end <= start) continue;
    const go = glyfT.offset + start;
    if (dv.getInt16(go) >= 0) continue; // simple glyph
    let p = go + 10;
    for (;;) {
      const flags = dv.getUint16(p);
      const comp = dv.getUint16(p + 2);
      if (!keep.has(comp)) {
        keep.add(comp);
        stack.push(comp);
      }
      p += 4;
      p += flags & 0x0001 ? 4 : 2; // ARG_1_AND_2_ARE_WORDS
      if (flags & 0x0008) p += 2; // WE_HAVE_A_SCALE
      else if (flags & 0x0040) p += 4; // X_AND_Y_SCALE
      else if (flags & 0x0080) p += 8; // TWO_BY_TWO
      if (!(flags & 0x0020)) break; // MORE_COMPONENTS
    }
  }

  let glyfSize = 0;
  for (const g of keep) if (g < f.numGlyphs) glyfSize += (loc(g + 1) - loc(g) + 3) & ~3;
  const glyf = new Uint8Array(glyfSize);
  const loca = new Uint8Array((f.numGlyphs + 1) * 4);
  const ldv = new DataView(loca.buffer);
  let p = 0;
  for (let g = 0; g < f.numGlyphs; g++) {
    ldv.setUint32(g * 4, p);
    if (keep.has(g)) {
      const s = loc(g);
      const e = loc(g + 1);
      if (e > s) {
        glyf.set(f.bytes.subarray(glyfT.offset + s, glyfT.offset + e), p);
        p += (e - s + 3) & ~3;
      }
    }
  }
  ldv.setUint32(f.numGlyphs * 4, p);

  const copy = (tag: string) => {
    const t = f.tables.get(tag);
    return t ? f.bytes.slice(t.offset, t.offset + t.length) : null;
  };
  const head = copy('head')!;
  new DataView(head.buffer).setInt16(50, 1); // long loca
  // post v3: no glyph names
  const post = new Uint8Array(32);
  const pdv = new DataView(post.buffer);
  pdv.setUint32(0, 0x00030000);
  pdv.setInt32(4, Math.round(f.italicAngle * 65536));
  pdv.setInt16(8, f.underlinePosition);
  pdv.setInt16(10, f.underlineThickness);
  pdv.setUint32(12, f.isFixedPitch ? 1 : 0);

  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'head', data: head },
    { tag: 'glyf', data: glyf.subarray(0, p) },
    { tag: 'loca', data: loca },
    { tag: 'post', data: post },
  ];
  // ISO 32000-1 §9.9: for a CIDFontType2 program "the cmap table is not needed and shall not be present".
  for (const tag of ['hhea', 'hmtx', 'maxp', 'cvt ', 'fpgm', 'prep', 'OS/2', 'name']) {
    const d = copy(tag);
    if (d) tables.push({ tag, data: d });
  }
  return buildSfnt(0x00010000, tables);
}

/**
 * Compact subset: only the used glyphs (plus .notdef and composite components) are kept and
 * renumbered 0..n-1, so glyf, loca and hmtx shrink to the glyphs actually drawn. Returns the font
 * and the old→new glyph id map; the PDF keeps old ids as CIDs and maps them with a CIDToGIDMap
 * stream (ISO 32000-1 §9.7.4.2), so page content is unaffected.
 */
export function subsetTrueTypeCompact(f: ParsedFont, used: Set<number>): { bytes: Uint8Array; map: Map<number, number> } | null {
  if (f.isCFF) return null;
  const dv = new DataView(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
  const headT = f.tables.get('head')!;
  const locaT = f.tables.get('loca');
  const glyfT = f.tables.get('glyf');
  const hheaT = f.tables.get('hhea')!;
  const hmtxT = f.tables.get('hmtx')!;
  const maxpT = f.tables.get('maxp')!;
  if (!locaT || !glyfT) return null;
  const longLoca = dv.getInt16(headT.offset + 50) === 1;
  const loc = (g: number) => (longLoca ? dv.getUint32(locaT.offset + g * 4) : dv.getUint16(locaT.offset + g * 2) * 2);
  const isComposite = (g: number) => loc(g + 1) > loc(g) && dv.getInt16(glyfT.offset + loc(g)) < 0;
  // Walk composite components; returns byte offsets (within the glyph) of each component index.
  const components = (g: number): { at: number; gid: number }[] => {
    const out: { at: number; gid: number }[] = [];
    if (!isComposite(g)) return out;
    let p = 10;
    const base = glyfT.offset + loc(g);
    for (;;) {
      const flags = dv.getUint16(base + p);
      out.push({ at: p + 2, gid: dv.getUint16(base + p + 2) });
      p += 4 + (flags & 0x0001 ? 4 : 2);
      if (flags & 0x0008) p += 2;
      else if (flags & 0x0040) p += 4;
      else if (flags & 0x0080) p += 8;
      if (!(flags & 0x0020)) break;
    }
    return out;
  };
  const keep = new Set<number>([0]);
  const stack = [...used].filter((g) => g < f.numGlyphs);
  for (const g of stack) keep.add(g);
  while (stack.length) {
    for (const c of components(stack.pop()!)) if (!keep.has(c.gid) && c.gid < f.numGlyphs) {
      keep.add(c.gid);
      stack.push(c.gid);
    }
  }
  const order = [...keep].sort((a, b) => a - b);
  const map = new Map(order.map((g, i) => [g, i]));
  const n = order.length;

  let glyfSize = 0;
  for (const g of order) glyfSize += (loc(g + 1) - loc(g) + 3) & ~3;
  const glyf = new Uint8Array(glyfSize);
  const loca = new Uint8Array((n + 1) * 4);
  const ldv = new DataView(loca.buffer);
  const gdv = new DataView(glyf.buffer);
  let p = 0;
  order.forEach((g, i) => {
    ldv.setUint32(i * 4, p);
    const s = loc(g);
    const e = loc(g + 1);
    if (e > s) {
      glyf.set(f.bytes.subarray(glyfT.offset + s, glyfT.offset + e), p);
      for (const c of components(g)) gdv.setUint16(p + c.at, map.get(c.gid) ?? 0);
      p += (e - s + 3) & ~3;
    }
  });
  ldv.setUint32(n * 4, p);

  const nhm = dv.getUint16(hheaT.offset + 34);
  const hmtx = new Uint8Array(n * 4);
  const hdv = new DataView(hmtx.buffer);
  order.forEach((g, i) => {
    const lsb = g < nhm ? dv.getInt16(hmtxT.offset + g * 4 + 2) : dv.getInt16(hmtxT.offset + nhm * 4 + (g - nhm) * 2);
    hdv.setUint16(i * 4, f.advances[g]);
    hdv.setInt16(i * 4 + 2, lsb);
  });
  const copy = (tag: string) => {
    const t = f.tables.get(tag);
    return t ? f.bytes.slice(t.offset, t.offset + t.length) : null;
  };
  const head = copy('head')!;
  new DataView(head.buffer).setInt16(50, 1);
  const hhea = copy('hhea')!;
  new DataView(hhea.buffer).setUint16(34, n);
  const maxp = copy('maxp')!;
  new DataView(maxp.buffer).setUint16(4, n);
  const post = new Uint8Array(32);
  const pdv = new DataView(post.buffer);
  pdv.setUint32(0, 0x00030000);
  pdv.setInt32(4, Math.round(f.italicAngle * 65536));
  pdv.setInt16(8, f.underlinePosition);
  pdv.setInt16(10, f.underlineThickness);
  pdv.setUint32(12, f.isFixedPitch ? 1 : 0);
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'head', data: head },
    { tag: 'hhea', data: hhea },
    { tag: 'maxp', data: maxp },
    { tag: 'hmtx', data: hmtx },
    { tag: 'loca', data: loca },
    { tag: 'glyf', data: glyf.subarray(0, p) },
    { tag: 'post', data: post },
  ];
  // Hinting tables keep the program correct on rasterizers that execute them; OS/2 carries metrics.
  for (const tag of ['cvt ', 'fpgm', 'prep', 'OS/2']) {
    const d = copy(tag);
    if (d) tables.push({ tag, data: d });
  }
  return { bytes: buildSfnt(0x00010000, tables), map };
}
