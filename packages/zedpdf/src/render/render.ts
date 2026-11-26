/**
 * Paint ops → PDF content streams.
 *
 * Every page's content stream starts with a CTM that maps CSS px (y down, origin at the content
 * area's top-left) to PDF points; geometry stays in CSS px with full precision until num() formats
 * it. Backgrounds and borders are vector paths. Text is real text: glyphs are positioned per word
 * with TJ adjustments so each word starts exactly where the browser placed it; a per-run horizontal
 * scale (Tz) absorbs small advance differences (kerning, hinting). Tw is not used because it does
 * not apply to 2-byte codes (ISO 32000-1 §9.3.3).
 */
import type { BoxPaint, Item, Op, RGBA, TextItem } from '../layout/model.js';
import type { Chain, FontManager, PdfFont } from '../font/fonts.js';
import type { PdfImageData } from '../image/codecs.js';
import { num } from '../pdf/writer.js';
import type { Warnings } from '../util.js';

const K = 0.5522847498;

export class Renderer {
  usedImages = new Set<number>();
  /** Link rectangles (content-area CSS px) collected for the page being rendered. */
  links: { x: number; y: number; w: number; h: number; href: string }[] = [];
  alphas = new Map<string, string>();
  private out: string[] = [];
  /**
   * Graphics-state tracker: colour, alpha and text state persist in a PDF content stream, so they
   * are emitted only when they change. q/Q push and pop the tracked state exactly like the reader.
   */
  private st: GState = initialState();
  private stack: GState[] = [];
  private q(): void {
    this.out.push('q');
    this.stack.push({ ...this.st });
  }
  private Q(): void {
    this.out.push('Q');
    this.st = this.stack.pop() ?? initialState();
  }
  private fill(c: RGBA): void {
    const v = rg(c);
    if (this.st.fill !== v) {
      this.out.push(v);
      this.st.fill = v;
    }
  }
  private stroke(c: RGBA): void {
    const v = rgS(c);
    if (this.st.stroke !== v) {
      this.out.push(v);
      this.st.stroke = v;
    }
  }
  private alpha(a: number): void {
    const key = a >= 0.999 ? '1' : num(a, 3);
    if (this.st.alpha === key) return;
    let n = this.alphas.get(key);
    if (!n) {
      n = `GS${this.alphas.size + 1}`;
      this.alphas.set(key, n);
    }
    this.out.push(`/${n} gs`);
    this.st.alpha = key;
  }
  private textState(op: 'tz' | 'tc' | 'tr' | 'tf' | 'lw', v: string, emit: string): void {
    if (this.st[op] !== v) {
      this.out.push(emit);
      this.st[op] = v;
    }
  }

  constructor(
    private fonts: FontManager,
    private images: (PdfImageData | null)[],
    private warn: Warnings,
  ) {}

  imageRes(i: number): string {
    return `Im${i}`;
  }

  /** Render one page. `origin` is the transform prefix placing the content area on the paper. */
  page(ops: Op[], prefix: string, extra: { items: Item[]; dy: number }[] = []): string {
    this.out = [prefix];
    this.st = initialState();
    this.stack = [];
    let clipDepth = 0;
    for (const o of ops) {
      switch (o.op) {
        case 'box':
          this.box(o.box, o.y0, o.y1, o.sliceTop, o.sliceBottom);
          break;
        case 'clip': {
          const f = o.frag;
          const b = f.box;
          const bt = f.sliceTop ? 0 : b.borders[0].w;
          const bb = f.sliceBottom ? 0 : b.borders[2].w;
          const radii = adjustRadii(b, f.sliceTop, f.sliceBottom).map(([rx, ry], i) => [Math.max(0, rx - b.borders[i === 0 || i === 3 ? 3 : 1].w), Math.max(0, ry - (i < 2 ? bt : bb))] as [number, number]);
          this.q();
          this.path(b.x + b.borders[3].w, f.y0 + bt, b.w - b.borders[1].w - b.borders[3].w, f.y1 - f.y0 - bt - bb, radii);
          this.out.push('W n');
          clipDepth++;
          break;
        }
        case 'cliprect':
          this.q();
          this.out.push(`${num(o.x)} ${num(o.y)} ${num(o.w)} ${num(o.h)} re W n`);
          clipDepth++;
          break;
        case 'unclip':
          if (clipDepth > 0) {
            this.Q();
            clipDepth--;
          }
          break;
        case 'items':
          if (o.scale) {
            const { s, ox, oy } = o.scale;
            this.q();
            this.out.push(`${num(s, 5)} 0 0 ${num(s, 5)} ${num((1 - s) * ox)} ${num((1 - s) * (oy + o.dy))} cm`);
            this.items(o.items, o.dy);
            this.Q();
          } else this.items(o.items, o.dy);
          break;
      }
    }
    while (clipDepth-- > 0) this.Q();
    for (const e of extra) this.items(e.items, e.dy);
    this.out.push('Q');
    return this.out.join('\n');
  }

  items(items: Item[], dy: number): void {
    let depth = 0;
    for (const it of items) {
      switch (it.k) {
        case 'box':
          this.box(it.box, it.box.y + dy, it.box.y + it.box.h + dy, false, false);
          break;
        case 'text':
          this.text(it, dy);
          break;
        case 'path':
          this.q();
          if (dy) this.out.push(`1 0 0 1 0 ${num(dy)} cm`);
          this.alpha(it.opacity * (it.fill ?? it.stroke)!.a);
          if (it.fill) this.fill(it.fill);
          if (it.stroke) {
            this.stroke(it.stroke);
            this.out.push(`${num(it.lineWidth ?? 1)} w 1 J 1 j`);
          }
          this.out.push(`${it.d} ${it.fill && it.stroke ? 'B' : it.fill ? 'f' : 'S'}`);
          this.Q();
          break;
        case 'image':
          this.image(it.asset, it.x, it.y + dy, it.w, it.h, it.opacity, it.clip ? { ...it.clip, y: it.clip.y + dy } : undefined);
          break;
        case 'clip':
          this.q();
          this.path(it.x, it.y + dy, it.w, it.h, it.radii ?? ZERO_RADII);
          this.out.push('W n');
          depth++;
          break;
        case 'unclip':
          if (depth > 0) {
            this.Q();
            depth--;
          }
          break;
      }
    }
    while (depth-- > 0) this.Q();
  }

  // ---------------------------------------------------------------- boxes

  box(b: BoxPaint, y0: number, y1: number, sliceTop: boolean, sliceBottom: boolean): void {
    const h = y1 - y0;
    if (h <= 0 || b.w <= 0) return;
    const radii = adjustRadii(b, sliceTop, sliceBottom);
    const out = this.out;
    if (b.shadows?.length) {
      for (const s of b.shadows) this.shadow(b, y0, h, radii, s, sliceTop, sliceBottom);
    }
    if (b.bg) {
      this.alpha(b.opacity * b.bg.a);
      this.fill(b.bg);
      this.path(b.x, y0, b.w, h, radii);
      out.push('f');
    }
    const [t0, r0, bt0, l0] = b.borders;
    const t = sliceTop ? 0 : t0.w;
    const bo = sliceBottom ? 0 : bt0.w;
    const r = r0.w;
    const l = l0.w;
    if (!t && !r && !bo && !l) return;
    const sides = [
      { ...t0, w: t },
      r0,
      { ...bt0, w: bo },
      l0,
    ];
    const uniform =
      sides.every((s) => s.w === t0.w && s.style === t0.style && sameColor(s.color, t0.color)) && /^(solid|inset|outset|groove|ridge)$/.test(t0.style);
    if (uniform) {
      this.alpha(b.opacity * t0.color.a);
      this.fill(t0.color);
      this.path(b.x, y0, b.w, h, radii);
      this.path(b.x + l, y0 + t, b.w - l - r, h - t - bo, radii.map(([rx, ry], i) => [Math.max(0, rx - (i === 0 || i === 3 ? l : r)), Math.max(0, ry - (i < 2 ? t : bo))] as [number, number]));
      out.push('f*');
      return;
    }
    const x0 = b.x;
    const x1 = b.x + b.w;
    const yb = y0 + h;
    // Trapezoids with mitred corners (radii are ignored for non-uniform borders).
    const polys: [typeof sides[0], number[]][] = [
      [sides[0], [x0, y0, x1, y0, x1 - r, y0 + t, x0 + l, y0 + t]],
      [sides[1], [x1, y0, x1, yb, x1 - r, yb - bo, x1 - r, y0 + t]],
      [sides[2], [x1, yb, x0, yb, x0 + l, yb - bo, x1 - r, yb - bo]],
      [sides[3], [x0, yb, x0, y0, x0 + l, y0 + t, x0 + l, yb - bo]],
    ];
    polys.forEach(([s, p], i) => {
      if (!s.w || !s.color.a) return;
      this.alpha(b.opacity * s.color.a);
      if (s.style === 'dashed' || s.style === 'dotted') {
        this.q();
        // Stroke along the side's centre line.
        const w = s.w;
        const line = [
          [x0, y0 + w / 2, x1, y0 + w / 2],
          [x1 - w / 2, y0, x1 - w / 2, yb],
          [x0, yb - w / 2, x1, yb - w / 2],
          [x0 + w / 2, y0, x0 + w / 2, yb],
        ][i];
        const dash = s.style === 'dashed' ? `[${num(w * 3)} ${num(w * 3)}] 0 d 0 J` : `[0 ${num(w * 2)}] 0 d 1 J`;
        out.push(`${rgS(s.color)} ${num(w)} w ${dash} ${num(line[0])} ${num(line[1])} m ${num(line[2])} ${num(line[3])} l S`);
        this.Q();
        return;
      }
      if (s.style === 'double' && s.w >= 3) {
        this.fill(s.color);
        const third = s.w / 3;
        const inner = [
          [x0, y0, x1 - x0, third, x0, y0 + 2 * third, x1 - x0, third],
          [x1 - third, y0, third, yb - y0, x1 - s.w, y0, third, yb - y0],
          [x0, yb - third, x1 - x0, third, x0, yb - s.w, x1 - x0, third],
          [x0, y0, third, yb - y0, x0 + 2 * third, y0, third, yb - y0],
        ][i];
        out.push(`${num(inner[0])} ${num(inner[1])} ${num(inner[2])} ${num(inner[3])} re ${num(inner[4])} ${num(inner[5])} ${num(inner[6])} ${num(inner[7])} re f`);
        return;
      }
      this.fill(s.color);
      // A side whose neighbours have no width is a plain rectangle (e.g. a row's bottom rule).
      const rect = [[x0, y0, x1 - x0, t, !l && !r], [x1 - r, y0, r, yb - y0, !t && !bo], [x0, yb - bo, x1 - x0, bo, !l && !r], [x0, y0, l, yb - y0, !t && !bo]][i] as [number, number, number, number, boolean];
      if (rect[4]) out.push(`${num(rect[0])} ${num(rect[1])} ${num(rect[2])} ${num(rect[3])} re f`);
      else out.push(`${num(p[0])} ${num(p[1])} m ${num(p[2])} ${num(p[3])} l ${num(p[4])} ${num(p[5])} l ${num(p[6])} ${num(p[7])} l h f`);
    });
  }

  private shadow(b: BoxPaint, y0: number, h: number, radii: [number, number][], s: NonNullable<BoxPaint['shadows']>[0], sliceTop: boolean, sliceBottom: boolean): void {
    if (sliceTop || sliceBottom) return; // shadows are not drawn on broken edges (§5.4 slice)
    const layers = s.blur > 0 ? 8 : 1;
    const out = this.out;
    for (let i = 0; i < layers; i++) {
      const e = layers === 1 ? s.spread : s.spread + s.blur * (0.5 - (i + 0.5) / layers);
      this.alpha((b.opacity * s.color.a) / layers);
      this.fill(s.color);
      this.path(b.x + s.x - e, y0 + s.y - e, b.w + 2 * e, h + 2 * e, radii.map(([rx, ry]) => [Math.max(0, rx + e), Math.max(0, ry + e)] as [number, number]));
      out.push('f');
    }
  }

  path(x: number, y: number, w: number, h: number, radii: [number, number][]): void {
    if (w <= 0 || h <= 0) return;
    // Scale radii down if they overlap (CSS Backgrounds §5.5).
    let f = 1;
    const [tl, tr, br, bl] = radii;
    const chk = (sum: number, len: number) => {
      if (sum > len && sum > 0) f = Math.min(f, len / sum);
    };
    chk(tl[0] + tr[0], w);
    chk(bl[0] + br[0], w);
    chk(tl[1] + bl[1], h);
    chk(tr[1] + br[1], h);
    const R = radii.map(([a, b]) => [a * f, b * f]);
    if (R.every(([a, b]) => a <= 0.01 && b <= 0.01)) {
      this.out.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re`);
      return;
    }
    const [a, b2, c, d] = R;
    const p: string[] = [];
    p.push(`${num(x + a[0])} ${num(y)} m`);
    p.push(`${num(x + w - b2[0])} ${num(y)} l`);
    if (b2[0] || b2[1]) p.push(`${num(x + w - b2[0] + b2[0] * K)} ${num(y)} ${num(x + w)} ${num(y + b2[1] - b2[1] * K)} ${num(x + w)} ${num(y + b2[1])} c`);
    p.push(`${num(x + w)} ${num(y + h - c[1])} l`);
    if (c[0] || c[1]) p.push(`${num(x + w)} ${num(y + h - c[1] + c[1] * K)} ${num(x + w - c[0] + c[0] * K)} ${num(y + h)} ${num(x + w - c[0])} ${num(y + h)} c`);
    p.push(`${num(x + d[0])} ${num(y + h)} l`);
    if (d[0] || d[1]) p.push(`${num(x + d[0] - d[0] * K)} ${num(y + h)} ${num(x)} ${num(y + h - d[1] + d[1] * K)} ${num(x)} ${num(y + h - d[1])} c`);
    p.push(`${num(x)} ${num(y + a[1])} l`);
    if (a[0] || a[1]) p.push(`${num(x)} ${num(y + a[1] - a[1] * K)} ${num(x + a[0] - a[0] * K)} ${num(y)} ${num(x + a[0])} ${num(y)} c`);
    p.push('h');
    this.out.push(p.join(' '));
  }

  // ---------------------------------------------------------------- images

  image(asset: number, x: number, y: number, w: number, h: number, opacity: number, clip?: { x: number; y: number; w: number; h: number }): void {
    if (!this.images[asset] || w <= 0 || h <= 0) return;
    this.usedImages.add(asset);
    const out = this.out;
    this.q();
    if (clip) out.push(`${num(clip.x)} ${num(clip.y)} ${num(clip.w)} ${num(clip.h)} re W n`);
    this.alpha(opacity);
    out.push(`${num(w)} 0 0 ${num(-h)} ${num(x)} ${num(y + h)} cm /${this.imageRes(asset)} Do`);
    this.Q();
  }

  // ---------------------------------------------------------------- text

  text(t: TextItem, dy: number): void {
    const idx = this.fonts.chainByKey.get(t.fontKey);
    if (idx === undefined || !t.words.length) return;
    const chain = this.fonts.chains[idx];
    const size = t.font.size;
    const ls = t.letterSpacing;
    const baseline = t.baseline + dy;
    const out = this.out;

    type G = { font: PdfFont; code: number; adv: number };
    const words = t.words.map((w) => {
      const glyphs: G[] = [];
      for (const ch of w.text) glyphs.push(this.fonts.glyph(chain, ch.codePointAt(0)!, ch));
      const natural = glyphs.reduce((s, g) => s + g.adv * size + ls, 0);
      return { w, glyphs, natural, raster: w.rasterId !== undefined && !!this.images[w.rasterId] && !!w.rasterRect };
    });
    let meas = 0;
    let nat = 0;
    for (const w of words) if (!w.raster) {
      meas += w.w.w;
      nat += w.natural;
    }
    let th = nat > 0 && meas > 0 ? meas / nat : 1;
    if (!(th > 0.5 && th < 2)) th = 1;

    // Raster words (complex-script fallback) first, so the invisible text layer sits on top.
    for (const w of words) if (w.raster) {
      const r = w.w.rasterRect!;
      this.image(w.w.rasterId!, r.x, r.y + dy, r.w, r.h, t.opacity * t.color.a);
    }

    // Text state (Tc, Tz, Tr, Tf) persists across BT/ET; the tracker emits only changes.
    this.alpha(t.opacity * t.color.a);
    this.fill(t.color);
    if (chain.synthBold) {
      this.stroke(t.color);
      const lw = num(size * 0.035);
      this.textState('lw', lw, `${lw} w`);
    }
    out.push('BT');
    const baseMode = chain.synthBold ? 2 : 0;
    const skew = chain.synthItalic ? 0.2 : 0;
    const setTz = (v: number) => {
      const z = num(v * 100, 2);
      this.textState('tz', z, `${z} Tz`);
    };
    setTz(th);
    const tc = num(ls / th, 3);
    this.textState('tc', tc, `${tc} Tc`);
    out.push(`1 0 ${num(skew, 3)} -1 ${num(words[0].w.x)} ${num(baseline)} Tm`);
    let open = false;
    let arr = '';
    const close = () => {
      if (open) {
        out.push(`[${arr}] TJ`);
        open = false;
        arr = '';
      }
    };
    const ensure = (f: PdfFont, m: number) => {
      const tf = `/${f.res} ${num(size, 3)} Tf`;
      if (tf !== this.st.tf || String(m) !== this.st.tr) {
        close();
        this.textState('tf', tf, tf);
        this.textState('tr', String(m), `${m} Tr`);
      }
      if (!open) {
        open = true;
        arr = '';
      }
    };
    let curX = words[0].w.x;
    let pendingAdj = 0;
    const hexOf = (gl: G) => (gl.font.kind === 'std' ? gl.code.toString(16).padStart(2, '0') : gl.code.toString(16).padStart(4, '0'));
    words.forEach((w, wi) => {
      const m = w.raster ? 3 : baseMode;
      if (wi > 0) {
        // Real space glyph between words keeps extraction faithful; then snap to the measured x.
        const sp = this.fonts.glyph(chain, 32, ' ');
        ensure(sp.font, words[wi - 1].raster ? 3 : baseMode);
        arr += (pendingAdj ? `${num(pendingAdj, 0)} ` : '') + `<${hexOf(sp)}>`;
        pendingAdj = 0;
        curX += (sp.adv * size + ls) * th;
        const delta = w.w.x - curX;
        if (Math.abs(delta) > 0.001) pendingAdj = (-delta * 1000) / (size * th);
        curX = w.w.x;
      }
      if (w.raster) {
        // Invisible layer for a browser-shaped (rasterized) word: unshaped advances differ from the
        // shaped width, so scale this word alone to its measured box. Positions stay monotonic,
        // which keeps extractors from inventing line breaks.
        close();
        const ws = w.natural > 0 ? Math.min(4, Math.max(0.25, w.w.w / w.natural)) : 1;
        setTz(ws);
        out.push(`1 0 ${num(skew, 3)} -1 ${num(w.w.x)} ${num(baseline)} Tm`);
        pendingAdj = 0;
        for (const gl of w.glyphs) {
          ensure(gl.font, 3);
          arr += `<${hexOf(gl)}>`;
        }
        close();
        curX = w.w.x + w.w.w;
        setTz(th);
        out.push(`1 0 ${num(skew, 3)} -1 ${num(curX)} ${num(baseline)} Tm`);
        return;
      }
      let localNat = 0;
      for (const gl of w.glyphs) {
        ensure(gl.font, m);
        arr += (pendingAdj ? `${num(pendingAdj, 0)} ` : '') + `<${hexOf(gl)}>`;
        pendingAdj = 0;
        localNat += gl.adv * size + ls;
      }
      curX += localNat * th;
    });
    close();
    out.push('ET');

    if (t.href) {
      const last = words[words.length - 1].w;
      const prev = this.links[this.links.length - 1];
      const x = words[0].w.x;
      const y = t.top + dy;
      // Merge with the previous fragment of the same link on the same line.
      if (prev && prev.href === t.href && Math.abs(prev.y - y) < 1 && x - (prev.x + prev.w) < t.font.size) {
        prev.w = last.x + last.w - prev.x;
      } else this.links.push({ x, y, w: last.x + last.w - x, h: t.h, href: t.href });
    }

    if (t.decorations.length) {
      const f0 = chain.fonts[0];
      const ul = f0.kind === 'embedded' ? -f0.parsed.underlinePosition / f0.parsed.unitsPerEm : -f0.metrics.underlinePosition / 1000;
      const ut = f0.kind === 'embedded' ? f0.parsed.underlineThickness / f0.parsed.unitsPerEm : f0.metrics.underlineThickness / 1000;
      const x0 = words[0].w.x;
      const last = words[words.length - 1].w;
      const x1 = last.x + last.w;
      for (const d of t.decorations) {
        const th2 = d.thickness ?? Math.max(1, ut * size);
        const y = d.kind === 'underline' ? baseline + ul * size : d.kind === 'line-through' ? baseline - size * 0.3 : t.top + dy;
        this.alpha(t.opacity * d.color.a);
        this.fill(d.color);
        out.push(`${num(x0)} ${num(y - th2 / 2)} ${num(x1 - x0)} ${num(th2)} re f`);
      }
    }
  }
}

interface GState {
  fill: string;
  stroke: string;
  alpha: string;
  tz: string;
  tc: string;
  tr: string;
  tf: string;
  lw: string;
}

/** PDF defaults at the start of a page (ISO 32000-1 Table 52/104): opaque, Tz 100, Tc 0, Tr 0. */
function initialState(): GState {
  return { fill: '', stroke: '', alpha: '1', tz: '100', tc: '0', tr: '0', tf: '', lw: '' };
}

const ZERO_RADII: [number, number][] = [[0, 0], [0, 0], [0, 0], [0, 0]];

function adjustRadii(b: BoxPaint, sliceTop: boolean, sliceBottom: boolean): [number, number][] {
  return b.radii.map((r, i) => ((sliceTop && i < 2) || (sliceBottom && i >= 2) ? [0, 0] : r)) as [number, number][];
}

function sameColor(a: RGBA, b: RGBA): boolean {
  return Math.abs(a.r - b.r) < 1e-3 && Math.abs(a.g - b.g) < 1e-3 && Math.abs(a.b - b.b) < 1e-3 && Math.abs(a.a - b.a) < 1e-3;
}

function rg(c: RGBA): string {
  return `${num(c.r, 4)} ${num(c.g, 4)} ${num(c.b, 4)} rg`;
}

function rgS(c: RGBA): string {
  return `${num(c.r, 4)} ${num(c.g, 4)} ${num(c.b, 4)} RG`;
}

export type { Chain };
