/**
 * Font resolution and embedding.
 *
 * A CSS font-family string does not give access to font bytes, and DOM geometry does not expose
 * glyph IDs. Bytes come from (1) options.fonts, (2) @font-face rules discovered in the copied
 * stylesheets (TTF/OTF/WOFF), via the caller's asset resolver or fetch. Glyph IDs come from the
 * font's own cmap; advances from hmtx. Fonts without bytes fall back to the PDF standard 14 fonts
 * (WinAnsi only) with a warning. Characters no font covers are reported, never silently replaced.
 *
 * Embedding (ISO 32000-1 §9.7, §9.9, §9.10): Type0 + CIDFontType2, Identity-H, CIDToGIDMap Identity,
 * /W widths, FontFile2 (TrueType outlines, glyph-subset with stable IDs) or FontFile3/OpenType (CFF),
 * and a ToUnicode CMap so text is selectable/searchable.
 */
import { embeddingAllowed, parseFontBytes, subsetTrueType, subsetTrueTypeCompact, type ParsedFont } from './sfnt.js';
import { STD_METRICS, STD_WIDTHS } from './standard14-data.js';
import type { PdfWriter, Ref } from '../pdf/writer.js';
import { pdfName } from '../pdf/writer.js';
import type { FontSpec } from '../layout/model.js';
import type { AssetResolver, FontSource } from '../types.js';
import { blobToBytes, withTimeout, type Warnings } from '../util.js';

export interface EmbeddedFont {
  kind: 'embedded';
  res: string;
  parsed: ParsedFont;
  /** gid → unicode text (first mapping wins). */
  used: Map<number, string>;
  weight: number;
  style: string;
  family: string;
}

export interface StdFont {
  kind: 'std';
  res: string;
  base: string;
  widths: number[];
  metrics: { ascender: number; descender: number; underlinePosition: number; underlineThickness: number };
  /** Set when any glyph is drawn with it; unused fallbacks are not written. */
  used: boolean;
}

export type PdfFont = EmbeddedFont | StdFont;

export interface Chain {
  fonts: PdfFont[];
  synthBold: boolean;
  synthItalic: boolean;
}

interface Face {
  family: string;
  weight: [number, number];
  style: string;
  src: string | Uint8Array | null;
  srcLabel: string;
  woff2Only?: boolean;
  ranges?: [number, number][];
  font?: Promise<EmbeddedFont | null>;
}

const GENERIC_SERIF = /^(serif|times|times new roman|georgia|cambria|garamond|tinos|liberation serif|ui-serif|book antiqua|palatino.*)$/;
const GENERIC_MONO = /^(monospace|courier|courier new|consolas|menlo|monaco|ui-monospace|sf mono|cousine|liberation mono|lucida console|source code pro)$/;
const METRIC_COMPAT = /^(arial|helvetica|helvetica neue|arimo|liberation sans|times|times new roman|tinos|liberation serif|courier|courier new|cousine|liberation mono)$/;

export class FontManager {
  faces: Face[] = [];
  chains: Chain[] = [];
  chainByKey = new Map<string, number>();
  embedded: EmbeddedFont[] = [];
  std = new Map<string, StdFont>();
  private resCounter = 0;
  missing = new Set<string>();

  constructor(
    private warn: Warnings,
    private resolver: AssetResolver | undefined,
    private timeout: number,
  ) {}

  addSources(list: FontSource[] | undefined): void {
    for (const f of list ?? []) {
      const w = f.weight ?? 400;
      this.faces.push({
        family: norm(f.family),
        weight: [w, w],
        style: f.style ?? 'normal',
        src: typeof f.src === 'string' ? f.src : null,
        srcLabel: typeof f.src === 'string' ? f.src : `options.fonts[${f.family} ${w}]`,
        font: typeof f.src === 'string' ? undefined : blobToBytes(f.src as Blob).then((b) => this.load(b, f.family, w, f.style ?? 'normal', 'options.fonts')),
      });
    }
  }

  /** Discover @font-face rules (url()s were made absolute when the stylesheets were copied). */
  discover(doc: Document): void {
    const visit = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        // Rules come from the iframe realm, so instanceof checks against this realm would fail.
        if (r.type === 5 || r.constructor?.name === 'CSSFontFaceRule') {
          const st = (r as CSSFontFaceRule).style;
          const family = norm(st.getPropertyValue('font-family'));
          const srcs = splitTop(st.getPropertyValue('src'));
          let url: string | null = null;
          let woff2Only = false;
          for (const s of srcs) {
            const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)/.exec(s);
            if (!m) continue;
            const fmt = /format\(\s*['"]?([^'")]+)/.exec(s)?.[1]?.toLowerCase();
            const isWoff2 = fmt === 'woff2' || (!fmt && /\.woff2(\?|#|$)/i.test(m[2]));
            if (isWoff2) {
              woff2Only = true;
              continue;
            }
            url = m[2];
            woff2Only = false;
            break;
          }
          const wv = (st.getPropertyValue('font-weight') || '400').trim().split(/\s+/).map((v) => (v === 'bold' ? 700 : v === 'normal' ? 400 : parseInt(v) || 400));
          const style = (st.getPropertyValue('font-style') || 'normal').trim().split(/\s+/)[0];
          const ranges = parseUnicodeRange(st.getPropertyValue('unicode-range'));
          this.faces.push({ family, weight: [wv[0], wv[1] ?? wv[0]], style, src: url, srcLabel: url ?? srcs.join(', '), woff2Only: !url && woff2Only, ranges });
        } else if ('cssRules' in r && (r as CSSGroupingRule).cssRules) {
          try {
            visit((r as CSSGroupingRule).cssRules);
          } catch {
            /* ignore */
          }
        }
      }
    };
    for (const sheet of Array.from(doc.styleSheets)) {
      try {
        visit(sheet.cssRules);
      } catch {
        /* cross-origin */
      }
    }
  }

  /** Resolve every font spec used by the document into a fallback chain, loading bytes as needed. */
  async prepare(specs: Map<string, FontSpec>): Promise<void> {
    for (const [key, spec] of specs) {
      const families = splitTop(spec.family).map(norm);
      const fonts: PdfFont[] = [];
      let synthBold = false;
      let synthItalic = false;
      let primaryResolved = false;
      let stdFor: string | null = null;
      for (let fi = 0; fi < families.length; fi++) {
        const fam = families[fi];
        const faces = this.faces.filter((f) => f.family === fam);
        if (faces.length) {
          // A family may be split by unicode-range into several faces; keep all of the best style/weight.
          const best = pickFaces(faces, spec.weight, spec.style);
          for (const face of best) {
            if (face.woff2Only) {
              this.warn.add('font-woff2-unsupported', 'warning', `Font '${fam}' is only available as WOFF2, which cannot be embedded yet`, null, `Provide a TTF/OTF/WOFF for '${fam}' with options.fonts or a woff/ttf src in @font-face`);
              continue;
            }
            const f = await this.faceFont(face);
            if (f) {
              fonts.push(f);
              if (fi === 0) primaryResolved = true;
              if (spec.weight >= 600 && f.weight < 600) synthBold = true;
              if (spec.style !== 'normal' && f.style === 'normal') synthItalic = true;
            }
          }
          if (fonts.length) continue;
        }
        if (!stdFor && !faces.length) stdFor = fam;
      }
      const stdName = stdFamily(stdFor ?? families[families.length - 1] ?? 'sans-serif', spec.weight, spec.style);
      fonts.push(this.stdFont(stdName));
      if (!primaryResolved) {
        const fam = families[0] ?? '';
        const compat = METRIC_COMPAT.test(fam) || /^(sans-serif|serif|monospace)$/.test(fam);
        this.warn.add(
          compat ? 'font-standard-substitute' : 'font-substituted',
          compat ? 'info' : 'warning',
          `No embeddable bytes for font '${fam}'; text uses the PDF standard font ${stdName} (positions still match the layout)`,
          null,
          `Supply '${fam}' (TTF/OTF/WOFF) via options.fonts or an @font-face rule`,
        );
      }
      this.chainByKey.set(key, this.chains.length);
      this.chains.push({ fonts, synthBold, synthItalic });
    }
  }

  private faceFont(face: Face): Promise<EmbeddedFont | null> {
    if (!face.font) {
      face.font = (async () => {
        if (!face.src) return null;
        const bytes = await this.fetchBytes(face.src as string);
        if (!bytes) {
          this.warn.add('font-unavailable', 'warning', `Font file could not be loaded: ${face.srcLabel}`, null, 'Check the URL/CORS, or provide the bytes with options.fonts / options.assetResolver');
          return null;
        }
        return this.load(bytes, face.family, face.weight[0], face.style, face.srcLabel);
      })();
    }
    return face.font;
  }

  private async fetchBytes(url: string): Promise<Uint8Array | null> {
    try {
      if (this.resolver) {
        const r = await this.resolver(url, 'font');
        if (r) return blobToBytes(r as Blob);
      }
      const res = await withTimeout(fetch(url), this.timeout, null);
      if (!res || !res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  private async load(bytes: Uint8Array, family: string, weight: number, style: string, label: string): Promise<EmbeddedFont | null> {
    try {
      const parsed = await parseFontBytes(bytes);
      if (!embeddingAllowed(parsed)) {
        this.warn.add('font-embedding-restricted', 'warning', `Font '${family}' forbids embedding (OS/2 fsType restricted)`, null, 'Use a font licensed for embedding');
        return null;
      }
      if (parsed.isVariable) {
        this.warn.add('variable-font-default-instance', 'warning', `Variable font '${family}' is embedded at its default instance; other weights are synthesized`, null, 'Provide static font files per weight');
      }
      const f: EmbeddedFont = { kind: 'embedded', res: `F${++this.resCounter}`, parsed, used: new Map(), weight: parsed.isVariable ? 400 : weight, style, family };
      this.embedded.push(f);
      return f;
    } catch (e) {
      this.warn.add('font-unavailable', 'warning', `Font ${label} could not be parsed: ${(e as Error).message}`, null, 'Provide a TTF/OTF/WOFF file');
      return null;
    }
  }

  stdFont(base: string): StdFont {
    let f = this.std.get(base);
    if (!f) {
      const fam = base.startsWith('Courier') ? null : base.replace('-Oblique', '').replace('-BoldOblique', '-Bold');
      const widths = fam ? STD_WIDTHS[fam] : new Array(224).fill(600);
      const m = STD_METRICS[fam ?? 'Helvetica'];
      f = {
        kind: 'std',
        res: `F${++this.resCounter}`,
        base,
        widths,
        metrics: fam ? m : { ascender: 629, descender: -157, underlinePosition: -100, underlineThickness: 50 },
        used: false,
      };
      this.std.set(base, f);
    }
    return f;
  }

  /** Pick the font and code for a code point. */
  glyph(chain: Chain, cp: number, ch: string): { font: PdfFont; code: number; adv: number } {
    for (const f of chain.fonts) {
      const g = this.tryFont(f, cp, ch);
      if (g) return g;
    }
    // Global fallback: any embedded font covering the character (like the browser's system fallback).
    for (const f of this.embedded) {
      const g = this.tryFont(f, cp, ch);
      if (g) return g;
    }
    if (!/\s/.test(ch)) this.missing.add(ch);
    const f = chain.fonts[0];
    if (f.kind === 'std') {
      f.used = true;
      return { font: f, code: 0x3f, adv: f.widths[0x3f - 32] / 1000 }; // '?' visible marker
    }
    f.used.set(0, f.used.get(0) ?? ch);
    return { font: f, code: 0, adv: f.parsed.advances[0] / f.parsed.unitsPerEm };
  }

  private tryFont(f: PdfFont, cp: number, ch: string): { font: PdfFont; code: number; adv: number } | null {
    if (f.kind === 'embedded') {
      const gid = f.parsed.glyphForCodePoint(cp);
      if (!gid) return null;
      if (!f.used.has(gid)) f.used.set(gid, ch);
      return { font: f, code: gid, adv: f.parsed.advances[gid] / f.parsed.unitsPerEm };
    }
    const code = winAnsi(cp);
    if (code == null) return null;
    const w = f.widths[code - 32];
    f.used = true;
    return { font: f, code, adv: (w || 0) / 1000 };
  }

  /** Write all used fonts; returns resource name → ref. */
  async write(pdf: PdfWriter): Promise<Map<string, Ref>> {
    const out = new Map<string, Ref>();
    for (const f of this.std.values()) {
      if (!f.used) continue;
      const ref = pdf.add(
        `<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 255 /Widths [${f.widths.join(' ')}] >>`,
      );
      out.set(f.res, ref);
    }
    for (const f of this.embedded) {
      if (!f.used.size) continue;
      out.set(f.res, await writeEmbedded(pdf, f));
    }
    return out;
  }
}

async function writeEmbedded(pdf: PdfWriter, f: EmbeddedFont): Promise<Ref> {
  const p = f.parsed;
  const scale = 1000 / p.unitsPerEm;
  const gids = [...f.used.keys()].sort((a, b) => a - b);
  const tag = subsetTag(p.postscriptName + gids.join(','));
  const baseName = `${tag}+${p.postscriptName || 'Font'}`;
  let fontFile: Ref;
  let cidToGid = '/Identity';
  let fileKey: string;
  if (p.isCFF) {
    fontFile = await pdf.addStream('/Subtype /OpenType', p.bytes);
    fileKey = 'FontFile3';
  } else {
    const compact = subsetTrueTypeCompact(p, new Set(gids));
    const sub = compact?.bytes ?? subsetTrueType(p, new Set(gids));
    fontFile = await pdf.addStream(`/Length1 ${sub.length}`, sub);
    if (compact) {
      // CID (= original glyph id used in page content) → glyph id in the compact font.
      const maxCid = gids[gids.length - 1];
      const m = new Uint8Array((maxCid + 1) * 2);
      for (const [oldId, newId] of compact.map) if (oldId <= maxCid) {
        m[oldId * 2] = newId >> 8;
        m[oldId * 2 + 1] = newId & 0xff;
      }
      cidToGid = (await pdf.addStream('', m)).toString();
    }
    fileKey = 'FontFile2';
  }
  const flags = 4 | (p.isFixedPitch ? 1 : 0) | (p.italicAngle !== 0 ? 64 : 0);
  const desc = pdf.add(
    `<< /Type /FontDescriptor /FontName ${pdfName(baseName)} /Flags ${flags} /FontBBox [${p.bbox.map((v) => Math.round(v * scale)).join(' ')}] /ItalicAngle ${p.italicAngle} /Ascent ${Math.round(p.ascender * scale)} /Descent ${Math.round(p.descender * scale)} /CapHeight ${Math.round(p.capHeight * scale)} /StemV 80 /${fileKey} ${fontFile} >>`,
  );
  // /W: runs of consecutive gids.
  let w = '';
  for (let i = 0; i < gids.length; ) {
    let j = i;
    while (j + 1 < gids.length && gids[j + 1] === gids[j] + 1) j++;
    w += `${gids[i]} [${gids.slice(i, j + 1).map((g) => Math.round(p.advances[g] * scale)).join(' ')}] `;
    i = j + 1;
  }
  const cid = pdf.add(
    `<< /Type /Font /Subtype /${p.isCFF ? 'CIDFontType0' : 'CIDFontType2'} /BaseFont ${pdfName(baseName)} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} /DW ${Math.round(p.advances[0] * scale)} /W [${w.trim()}]${p.isCFF ? '' : ` /CIDToGIDMap ${cidToGid}`} >>`,
  );
  const tu = await pdf.addStream('', new TextEncoder().encode(toUnicodeCMap(f.used)));
  return pdf.add(`<< /Type /Font /Subtype /Type0 /BaseFont ${pdfName(baseName)} /Encoding /Identity-H /DescendantFonts [${cid}] /ToUnicode ${tu} >>`);
}

export function toUnicodeCMap(used: Map<number, string>): string {
  const entries = [...used.entries()].sort((a, b) => a[0] - b[0]);
  let body = '';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n`;
    for (const [gid, text] of chunk) body += `<${hex4(gid)}> <${utf16hex(text)}>\n`;
    body += 'endbfchar\n';
  }
  return (
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    body +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n'
  );
}

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

function utf16hex(s: string): string {
  let o = '';
  for (let i = 0; i < s.length; i++) o += hex4(s.charCodeAt(i));
  return o;
}

function subsetTag(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  let t = '';
  for (let i = 0; i < 6; i++) {
    t += String.fromCharCode(65 + (h % 26));
    h = Math.floor(h / 26) + i * 7919;
  }
  return t;
}

function norm(f: string): string {
  return f.trim().replace(/^['"]|['"]$/g, '').trim().toLowerCase();
}

/** Split a comma list at top level (not inside parentheses or quotes). */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q = '';
  let cur = '';
  for (const ch of s) {
    if (q) {
      if (ch === q) q = '';
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseUnicodeRange(v: string): [number, number][] | undefined {
  if (!v) return undefined;
  const out: [number, number][] = [];
  for (const part of v.split(',')) {
    const m = /U\+([0-9A-F?]+)(?:-([0-9A-F]+))?/i.exec(part.trim());
    if (!m) continue;
    if (m[1].includes('?')) out.push([parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'F'), 16)]);
    else out.push([parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16)]);
  }
  return out.length ? out : undefined;
}

function pickFaces(faces: Face[], weight: number, style: string): Face[] {
  const styleRank = (s: string) => (style === 'normal' ? (s === 'normal' ? 0 : 1) : s === style ? 0 : s !== 'normal' ? 0.5 : 1);
  const wDist = (f: Face) => {
    if (weight >= f.weight[0] && weight <= f.weight[1]) return 0;
    const w = weight < f.weight[0] ? f.weight[0] : f.weight[1];
    // CSS Fonts 4 §5.2: for desired > 500 prefer heavier, for < 400 prefer lighter.
    const d = Math.abs(w - weight);
    return weight > 500 ? (w > weight ? d : d + 1000) : weight < 400 ? (w < weight ? d : d + 1000) : d;
  };
  let bestScore = Infinity;
  for (const f of faces) bestScore = Math.min(bestScore, styleRank(f.style) * 10000 + wDist(f));
  return faces.filter((f) => styleRank(f.style) * 10000 + wDist(f) === bestScore);
}

function stdFamily(fam: string, weight: number, style: string): string {
  const bold = weight >= 600;
  const it = style !== 'normal';
  if (GENERIC_MONO.test(fam)) return `Courier${bold && it ? '-BoldOblique' : bold ? '-Bold' : it ? '-Oblique' : ''}`;
  if (GENERIC_SERIF.test(fam)) return `Times-${bold && it ? 'BoldItalic' : bold ? 'Bold' : it ? 'Italic' : 'Roman'}`;
  return `Helvetica${bold && it ? '-BoldOblique' : bold ? '-Bold' : it ? '-Oblique' : ''}`;
}

const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

export function winAnsi(cp: number): number | null {
  if (cp >= 0x20 && cp <= 0x7e) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  return WIN_ANSI_EXTRA[cp] ?? null;
}
