/**
 * DOM → measured fragmentation tree.
 *
 * Text: each word's geometry comes from a Range over the text node (CSSOM View
 * Range.getClientRects), one call per word. Words are grouped into line runs by their measured
 * top; the browser's own wrapping is therefore reused exactly, with no per-character or per-page
 * re-layout. Words that wrap internally (overflow-wrap) are split by per-character rects.
 * Baselines come from one probe per distinct font (an empty inline-block's bottom = baseline).
 *
 * Boxes: getBoundingClientRect / getClientRects (inline fragments) + computed style.
 */
import type {
  BlockNode,
  BoxPaint,
  BorderSide,
  Brk,
  CellNode,
  Decoration,
  FNode,
  FontSpec,
  ImageItem,
  Item,
  LeafNode,
  LineNode,
  ParallelNode,
  RowNode,
  TableNode,
  TextItem,
  Word,
} from './model.js';
import { parseColor, type Warnings } from '../util.js';

export type AssetRequest =
  | { kind: 'url'; src: string; el: HTMLImageElement | null; w: number; h: number }
  | { kind: 'element'; el: Element; w: number; h: number }
  | { kind: 'word'; item: TextItem; word: Word; w: number; h: number; also: { item: TextItem; word: Word }[] };

export interface WalkOptions {
  complexScriptFallback: 'none' | 'raster';
  keepHeadingsWithNext: boolean;
}

export interface Furniture {
  items: Item[];
  /** Layout top of the furniture box (items are relative to the export origin). */
  top: number;
  height: number;
}

export interface WalkResult {
  root: BlockNode;
  assets: AssetRequest[];
  fonts: Map<string, FontSpec>;
  texts: TextItem[];
  header?: Furniture;
  footer?: Furniture;
  /** Root content wider than the page content area. */
  overflowX: number;
}

const COMPLEX_RE = /[֐-ࣿऀ-෿฀-࿿က-႟ក-៿יִ-﷿ﹰ-﻿]/;
const WORD_RE = /[^ \t\n\r\f]+/g;
const HTML_NS = 'http://www.w3.org/1999/xhtml';

interface InlineEntry {
  items: Item[];
  top: number; // glyph / border top
  bottom: number;
  lt: number; // line-box contribution
  lb: number;
  seq: number;
}

interface Ctx {
  blocks: FNode[];
  inline: InlineEntry[];
}

export function walk(win: Window, root: HTMLElement, o: WalkOptions, warn: Warnings, furniture?: { header?: HTMLElement; footer?: HTMLElement }): WalkResult {
  const w = new Walker(win, root, o, warn);
  const node = w.block(root, win.getComputedStyle(root), 1, []);
  node.brkBefore = 'auto';
  node.brkAfter = 'auto';
  const res: WalkResult = { root: node, assets: w.assets, fonts: w.fonts, texts: w.texts, overflowX: 0 };
  if (furniture?.header) res.header = w.furniture(furniture.header);
  if (furniture?.footer) res.footer = w.furniture(furniture.footer);
  const contentWidth = win.innerWidth;
  res.overflowX = Math.max(0, w.maxRight - contentWidth);
  w.probeBaselines();
  return res;
}

class Walker {
  ox: number;
  oy: number;
  range: Range;
  seq = 0;
  assets: AssetRequest[] = [];
  assetBySrc = new Map<string, number>();
  /** Identical complex-script words share one raster. */
  wordAssets = new Map<string, number>();
  fonts = new Map<string, FontSpec>();
  texts: TextItem[] = [];
  maxRight = 0;
  inFurniture: 'header' | 'footer' | null = null;

  constructor(
    public win: Window,
    public root: HTMLElement,
    public o: WalkOptions,
    public warn: Warnings,
  ) {
    const doc = root.ownerDocument;
    this.range = doc.createRange();
    this.ox = doc.documentElement.getBoundingClientRect().left;
    this.oy = root.getBoundingClientRect().top;
  }

  cs(el: Element): CSSStyleDeclaration {
    return this.win.getComputedStyle(el);
  }

  // ------------------------------------------------------------------ blocks

  block(el: HTMLElement, cs: CSSStyleDeclaration, op: number, deco: Decoration[]): BlockNode {
    const r = el.getBoundingClientRect();
    const top = r.top - this.oy;
    const bottom = r.bottom - this.oy;
    this.maxRight = Math.max(this.maxRight, r.right - this.ox);
    const myOp = op * parseFloat(cs.opacity || '1');
    const box = this.boxPaint(el, cs, r, myOp);
    const ctx: Ctx = { blocks: [], inline: [] };
    const d2 = this.decorations(cs, deco);
    this.content(el, myOp, d2, ctx);
    const multicol = (cs.columnCount !== 'auto' && cs.columnCount !== '1' && cs.columnCount !== '') || (cs.columnWidth !== 'auto' && cs.columnWidth !== '');
    const children = multicol ? arrangeColumns([...ctx.blocks, ...lines(ctx.inline)]) : arrange([...ctx.blocks, ...lines(ctx.inline)]);
    const clip = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    const node: BlockNode = {
      kind: 'block',
      top,
      bottom: Math.max(bottom, top),
      box,
      clip: clip && !!box,
      children,
      orphans: parseInt(cs.orphans) || 2,
      widows: parseInt(cs.widows) || 2,
      ...this.breaks(el, cs),
      el,
    };
    if (clip && !box) node.box = transparentBox(r, this.ox, this.oy), (node.clip = true);
    // Breaks on first/last children propagate to the parent edge (CSS Fragmentation §3.1).
    if (children.length) {
      if (children[0].brkBefore === 'page') node.brkBefore = 'page';
      else if (children[0].brkBefore === 'avoid' && node.brkBefore === 'auto') node.brkBefore = 'avoid';
      const last = children[children.length - 1];
      if (last.brkAfter === 'page') node.brkAfter = 'page';
      else if (last.brkAfter === 'avoid' && node.brkAfter === 'auto') node.brkAfter = 'avoid';
    }
    return node;
  }

  breaks(el: Element, cs: CSSStyleDeclaration): { brkBefore: Brk; brkAfter: Brk; brkInside: 'auto' | 'avoid' } {
    const b = (v: string): Brk => (/^(page|always|left|right|recto|verso)$/.test(v) ? 'page' : /^avoid/.test(v) ? 'avoid' : 'auto');
    let brkAfter = b(cs.breakAfter || (cs as any).pageBreakAfter || '');
    if (brkAfter === 'auto' && this.o.keepHeadingsWithNext && /^h[1-6]$/.test(el.localName)) brkAfter = 'avoid';
    return {
      brkBefore: b(cs.breakBefore || (cs as any).pageBreakBefore || ''),
      brkAfter,
      brkInside: /^avoid/.test(cs.breakInside || (cs as any).pageBreakInside || '') ? 'avoid' : 'auto',
    };
  }

  content(el: Element, op: number, deco: Decoration[], ctx: Ctx): void {
    // A closed <details> renders only its <summary> (the rest is hidden by the UA shadow tree,
    // which computed style does not reveal).
    const closedDetails = el.localName === 'details' && !(el as HTMLDetailsElement).open;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (closedDetails && !(n.nodeType === 1 && (n as Element).localName === 'summary')) continue;
      if (n.nodeType === 3) this.text(n as Text, el, op, deco, ctx);
      else if (n.nodeType === 1) this.element(n as Element, op, deco, ctx);
    }
  }

  element(el: Element, op: number, deco: Decoration[], ctx: Ctx): void {
    const tag = el.localName;
    if (tag === 'br' || tag === 'wbr' || tag === 'template' || tag === 'style' || tag === 'script' || tag === 'head') return;
    const cs = this.cs(el);
    const display = cs.display;
    if (display === 'none') return;
    if (display === 'contents') {
      this.content(el, op, this.decorations(cs, deco), ctx);
      return;
    }
    this.unsupported(el, cs);
    const isInline = display.startsWith('inline') || display === 'ruby';
    const myOp = op * parseFloat(cs.opacity || '1');

    if (isReplaced(el)) {
      const items = this.replaced(el, cs, myOp);
      const r = el.getBoundingClientRect();
      const top = r.top - this.oy;
      const bottom = r.bottom - this.oy;
      if (isInline) ctx.inline.push({ items, top, bottom, lt: top, lb: bottom, seq: this.seq++ });
      else
        ctx.blocks.push({
          kind: 'leaf',
          top,
          bottom,
          items,
          imageOnly: items.some((i) => i.k === 'image') && items.every((i) => i.k === 'image' || i.k === 'box'),
          ...this.breaks(el, cs),
          brkInside: 'avoid',
          el,
        });
      return;
    }
    if (display === 'table' && (el as HTMLElement).localName !== 'svg' && isRealTable(el, this)) {
      ctx.blocks.push(this.table(el as HTMLElement, cs, myOp, this.decorations(cs, deco)));
      return;
    }
    if (display === 'inline') {
      // Inline box fragments (one rect per line), then its content joins the same IFC.
      const box = this.boxPaint(el, cs, el.getBoundingClientRect(), myOp, true);
      if (box) {
        for (const r of Array.from(el.getClientRects())) {
          if (r.width === 0 && r.height === 0) continue;
          const b = { ...box, x: r.left - this.ox, y: r.top - this.oy, w: r.width, h: r.height };
          ctx.inline.push({ items: [{ k: 'box', box: b }], top: b.y, bottom: b.y + b.h, lt: b.y, lb: b.y + b.h, seq: this.seq++ });
        }
      }
      this.content(el, myOp, this.decorations(cs, deco), ctx);
      return;
    }
    if (isInline) {
      // inline-block / inline-flex / inline-grid / inline-table: atomic inline.
      const node = this.block(el as HTMLElement, cs, op, deco);
      ctx.inline.push({ items: collectItems(node), top: node.top, bottom: node.bottom, lt: node.top, lb: node.bottom, seq: this.seq++ });
      return;
    }
    ctx.blocks.push(this.block(el as HTMLElement, cs, op, deco));
  }

  // ------------------------------------------------------------------ tables

  table(el: HTMLElement, cs: CSSStyleDeclaration, op: number, deco: Decoration[]): TableNode {
    const r = el.getBoundingClientRect();
    this.maxRight = Math.max(this.maxRight, r.right - this.ox);
    const collapse = cs.borderCollapse === 'collapse';
    let box = this.boxPaint(el, cs, r, op);
    if (box && collapse) {
      // In the collapsing model the table's outer border is resolved into the cells' borders.
      box = { ...box, borders: box.borders.map((s) => ({ ...s, w: 0 })) as BoxPaint['borders'] };
      if (!box.bg) box = null;
    }
    const caption: FNode[] = [];
    const head: RowNode[] = [];
    const body: RowNode[] = [];
    const foot: RowNode[] = [];
    let headSeen = false;
    let footSeen = false;
    for (const sec of Array.from(el.children)) {
      const scs = this.cs(sec);
      const d = scs.display;
      if (d === 'table-caption') caption.push(this.block(sec as HTMLElement, scs, op, deco));
      else if (d === 'table-row') body.push(this.row(sec as HTMLElement, scs, op, deco));
      else if (d === 'table-header-group' || d === 'table-footer-group' || d === 'table-row-group') {
        if (parseColor(scs.backgroundColor)) {
          this.warn.add('row-group-background', 'warning', 'Backgrounds on <thead>/<tbody>/<tfoot> are not painted', sec, 'Put the background on the rows or cells');
        }
        const rows = Array.from(sec.children)
          .filter((x) => this.cs(x).display === 'table-row')
          .map((tr) => this.row(tr as HTMLElement, this.cs(tr), op, deco));
        if (d === 'table-header-group' && !headSeen) {
          head.push(...rows);
          headSeen = true;
        } else if (d === 'table-footer-group' && !footSeen) {
          foot.push(...rows);
          footSeen = true;
        } else body.push(...rows);
      }
    }
    // A table drawn upside down by the cascade (e.g. thead after tbody visually) is not supported;
    // sections are paginated in DOM-defined order, which matches CSS table layout.
    computeSpans(body);
    computeSpans(foot);
    for (const row of head) if (row.cells.some((c) => c.rowSpan > 1)) {
      this.warn.add('rowspan-in-header', 'info', 'rowspan inside <thead> is painted as part of the header rows', row.el);
    }
    return {
      kind: 'table',
      top: r.top - this.oy,
      bottom: r.bottom - this.oy,
      box,
      caption,
      head,
      body,
      foot,
      ...this.breaks(el, cs),
      el,
    };
  }

  row(tr: HTMLElement, cs: CSSStyleDeclaration, op: number, deco: Decoration[]): RowNode {
    const r = tr.getBoundingClientRect();
    const box = this.boxPaint(tr, cs, r, op);
    const cells: CellNode[] = [];
    for (const td of Array.from(tr.children)) {
      const ccs = this.cs(td);
      if (ccs.display === 'none') continue;
      const cr = td.getBoundingClientRect();
      const cop = op * parseFloat(ccs.opacity || '1');
      const cbox = this.boxPaint(td, ccs, cr, cop);
      const ctx: Ctx = { blocks: [], inline: [] };
      this.unsupported(td, ccs);
      this.content(td, cop, this.decorations(ccs, deco), ctx);
      cells.push({
        box: cbox,
        top: cr.top - this.oy,
        bottom: cr.bottom - this.oy,
        padBottom: parseFloat(ccs.paddingBottom) + parseFloat(ccs.borderBottomWidth),
        children: arrange([...ctx.blocks, ...lines(ctx.inline)]),
        rowSpan: (td as HTMLTableCellElement).rowSpan || 1,
        colSpan: (td as HTMLTableCellElement).colSpan || 1,
        el: td,
      });
    }
    return {
      kind: 'row',
      top: r.top - this.oy,
      bottom: r.bottom - this.oy,
      box,
      cells,
      spanEnd: -1,
      // Author break-inside is kept: rows are always kept intact when they fit on a fresh page;
      // a taller row with break-inside: avoid first moves to a fresh page (as Chromium print does),
      // while break-inside: auto starts fragmenting on the current page (CSS Tables 3 §6.1).
      ...this.breaks(tr, cs),
      el: tr,
    };
  }

  // ------------------------------------------------------------------ text

  text(node: Text, parent: Element, op: number, deco: Decoration[], ctx: Ctx): void {
    const data = node.data;
    if (!/[^\s]/.test(data) && !data.includes(' ')) return;
    const cs = this.cs(parent);
    if (cs.visibility !== 'visible') return;
    const font: FontSpec = {
      family: cs.fontFamily,
      weight: parseInt(cs.fontWeight) || 400,
      style: cs.fontStyle.startsWith('italic') ? 'italic' : cs.fontStyle.startsWith('oblique') ? 'oblique' : 'normal',
      size: parseFloat(cs.fontSize),
    };
    if (!(font.size > 0)) return;
    const fontKey = `${font.style}|${font.weight}|${font.size}|${font.family}`;
    if (!this.fonts.has(fontKey)) this.fonts.set(fontKey, font);
    const color = parseColor((cs as any).webkitTextFillColor || cs.color) ?? parseColor(cs.color);
    if (!color) return;
    const transform = cs.textTransform;
    const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0;
    if (cs.fontVariantCaps && cs.fontVariantCaps !== 'normal') {
      this.warn.add('font-variant-caps', 'warning', `font-variant-caps: ${cs.fontVariantCaps} is drawn as normal glyphs`, parent);
    }
    let token: 'page' | 'pages' | undefined;
    const anchor = parent.closest('a[href]') as HTMLAnchorElement | null;
    const href = anchor && /^(https?:|mailto:|tel:)/i.test(anchor.href) ? anchor.href : undefined;
    if (this.inFurniture) {
      const t = parent.closest('.pageNumber, .totalPages');
      if (t) token = t.classList.contains('pageNumber') ? 'page' : 'pages';
    }

    const pieces: { text: string; x: number; w: number; top: number; h: number }[] = [];
    const rg = this.range;
    WORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_RE.exec(data))) {
      const s = m.index;
      const e = s + m[0].length;
      rg.setStart(node, s);
      rg.setEnd(node, e);
      const rects = rg.getClientRects();
      if (!rects.length) continue;
      let single = true;
      for (let i = 1; i < rects.length; i++) if (Math.abs(rects[i].top - rects[0].top) > 1) single = false;
      if (single) {
        const b = rg.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        pieces.push({ text: m[0], x: b.left - this.ox, w: b.width, top: b.top - this.oy, h: b.height });
      } else {
        // The word wraps internally (overflow-wrap / word-break): split per character.
        let cur: (typeof pieces)[0] | null = null;
        for (let k = s; k < e; ) {
          const cp = data.codePointAt(k)!;
          const len = cp > 0xffff ? 2 : 1;
          rg.setStart(node, k);
          rg.setEnd(node, k + len);
          const b = rg.getBoundingClientRect();
          const ch = data.slice(k, k + len);
          const top = b.top - this.oy;
          if (cur && Math.abs(cur.top - top) <= 1) {
            cur.text += ch;
            cur.w = b.right - this.ox - cur.x;
          } else {
            if (cur) pieces.push(cur);
            cur = { text: ch, x: b.left - this.ox, w: b.width, top, h: b.height };
          }
          k += len;
        }
        if (cur) pieces.push(cur);
      }
    }
    if (!pieces.length) return;

    const lh = cs.lineHeight === 'normal' ? NaN : parseFloat(cs.lineHeight);
    let run: TextItem | null = null;
    const flush = () => {
      if (!run) return;
      const half = Number.isFinite(lh) ? (lh - run.h) / 2 : 0;
      const last = run.words[run.words.length - 1];
      this.maxRight = Math.max(this.maxRight, last.x + last.w);
      ctx.inline.push({ items: [run], top: run.top, bottom: run.top + run.h, lt: run.top - half, lb: run.top + run.h + half, seq: this.seq++ });
      this.texts.push(run);
      run = null;
    };
    for (const p of pieces) {
      if (run && Math.abs(run.top - p.top) > 1) flush();
      if (!run) {
        run = {
          k: 'text',
          top: p.top,
          h: p.h,
          baseline: p.top + p.h * 0.8,
          font,
          fontKey,
          color,
          opacity: op,
          letterSpacing: ls,
          words: [],
          decorations: deco,
          token,
          href,
        };
      }
      const text = applyTransform(p.text, transform);
      const word: Word = { text, x: p.x, w: p.w };
      if (COMPLEX_RE.test(text)) {
        word.complex = true;
        if (this.o.complexScriptFallback === 'raster') {
          const key = `${fontKey}|${color.r},${color.g},${color.b}|${ls}|${p.h.toFixed(2)}|${p.w.toFixed(1)}|${text}`;
          const prev = this.wordAssets.get(key);
          if (prev !== undefined) {
            word.rasterId = prev;
            (this.assets[prev] as Extract<AssetRequest, { kind: 'word' }>).also.push({ item: run, word });
          } else {
            word.rasterId = this.assets.length;
            this.wordAssets.set(key, word.rasterId);
            this.assets.push({ kind: 'word', item: run, word, w: p.w, h: p.h, also: [] });
          }
          this.warn.add('complex-script-rasterized', 'info', 'Complex-script words are drawn as browser-shaped images with an invisible, selectable text layer', parent);
        } else {
          this.warn.add(
            'complex-script-unshaped',
            'warning',
            'Text in a script that needs OpenType shaping (e.g. Devanagari conjuncts) is drawn with unshaped glyphs; it extracts correctly but may look wrong',
            parent,
            "Pass complexScriptFallback: 'raster' (browser-shaped images + invisible text layer) or use printElement()",
          );
        }
      }
      run.words.push(word);
    }
    flush();
  }

  decorations(cs: CSSStyleDeclaration, inherited: Decoration[]): Decoration[] {
    const line = cs.textDecorationLine;
    if (!line || line === 'none') return inherited;
    const color = parseColor(cs.textDecorationColor) ?? parseColor(cs.color);
    if (!color) return inherited;
    const th = cs.textDecorationThickness;
    const thickness = th && th !== 'auto' && th !== 'from-font' ? parseFloat(th) : null;
    const out = [...inherited];
    for (const kind of ['underline', 'line-through', 'overline'] as const) {
      if (line.includes(kind)) out.push({ kind, color, thickness, style: cs.textDecorationStyle });
    }
    return out;
  }

  // ------------------------------------------------------------------ boxes

  boxPaint(el: Element, cs: CSSStyleDeclaration, r: DOMRect, op: number, inline = false): BoxPaint | null {
    if (cs.visibility !== 'visible') return null;
    const bg = parseColor(cs.backgroundColor);
    const side = (w: string, s: string, c: string): BorderSide => {
      const width = s === 'none' || s === 'hidden' ? 0 : parseFloat(w) || 0;
      const color = parseColor(c);
      // Transparent sides keep their width: it still shapes the box (e.g. CSS triangles).
      return { w: width, style: s, color: color ?? { r: 0, g: 0, b: 0, a: 0 } };
    };
    const borders: BoxPaint['borders'] = [
      side(cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor),
      side(cs.borderRightWidth, cs.borderRightStyle, cs.borderRightColor),
      side(cs.borderBottomWidth, cs.borderBottomStyle, cs.borderBottomColor),
      side(cs.borderLeftWidth, cs.borderLeftStyle, cs.borderLeftColor),
    ];
    const shadows = cs.boxShadow && cs.boxShadow !== 'none' ? parseShadows(cs.boxShadow) : undefined;
    if (!bg && borders.every((b) => b.w === 0 || b.color.a === 0) && !shadows?.length) return null;
    const radius = (v: string): [number, number] => {
      const parts = v.split(/\s+/);
      const rx = parts[0].endsWith('%') ? (parseFloat(parts[0]) / 100) * r.width : parseFloat(parts[0]) || 0;
      const ry = parts[1] ? (parts[1].endsWith('%') ? (parseFloat(parts[1]) / 100) * r.height : parseFloat(parts[1]) || 0) : parts[0].endsWith('%') ? (parseFloat(parts[0]) / 100) * r.height : rx;
      return [rx, ry];
    };
    const radii = inline
      ? [[0, 0], [0, 0], [0, 0], [0, 0]] as [number, number][]
      : [radius(cs.borderTopLeftRadius), radius(cs.borderTopRightRadius), radius(cs.borderBottomRightRadius), radius(cs.borderBottomLeftRadius)];
    return { x: r.left - this.ox, y: r.top - this.oy, w: r.width, h: r.height, bg, borders, radii, opacity: op, shadows };
  }

  unsupported(el: Element, cs: CSSStyleDeclaration): void {
    const W = this.warn;
    if (cs.transform && cs.transform !== 'none') {
      const m = /^matrix\(([^)]+)\)$/.exec(cs.transform);
      const v = m ? m[1].split(',').map(parseFloat) : null;
      const translateOnly = v && v[0] === 1 && v[1] === 0 && v[2] === 0 && v[3] === 1;
      if (!translateOnly) W.add('transform-unsupported', 'warning', 'CSS transforms other than translation are not exported; the element is drawn untransformed at its bounding box', el, "Remove the transform for export via options.css, e.g. '.x { transform: none }'");
    }
    if (cs.filter && cs.filter !== 'none') W.add('filter-unsupported', 'warning', `filter: ${cs.filter} is not exported`, el, 'Remove the filter for export via options.css');
    if (cs.position === 'fixed') W.add('fixed-element', 'warning', 'position: fixed element is drawn once at its position (native print repeats fixed elements on every page)', el, 'Use options.header / options.footer for repeated page furniture');
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      const grad = cs.backgroundImage.includes('gradient');
      W.add(grad ? 'background-gradient-unsupported' : 'background-image-unsupported', 'warning', `${grad ? 'Gradient backgrounds' : 'CSS background images'} are not exported yet (the background colour is used)`, el, 'Use an <img> element for logos/watermarks, or a solid background-color for export');
    }
    if (cs.boxShadow && cs.boxShadow !== 'none' && /inset/.test(cs.boxShadow)) W.add('box-shadow-inset', 'warning', 'Inset box-shadows are not exported', el);
    if (cs.textShadow && cs.textShadow !== 'none') W.add('text-shadow-unsupported', 'warning', 'text-shadow is not exported', el);
    if (cs.clipPath && cs.clipPath !== 'none') W.add('clip-path-unsupported', 'warning', 'clip-path is not exported', el);
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') W.add('blend-mode-unsupported', 'warning', 'mix-blend-mode is not exported', el);
    if (cs.writingMode && !cs.writingMode.startsWith('horizontal')) W.add('writing-mode-unsupported', 'warning', 'Vertical writing modes are not supported', el);
    if (cs.direction === 'rtl') W.add('rtl-text', 'warning', 'Right-to-left text is drawn in measured word order without bidi shaping', el, "Use complexScriptFallback: 'raster' or printElement()");
  }

  // ------------------------------------------------------------------ replaced elements

  replaced(el: Element, cs: CSSStyleDeclaration, op: number): Item[] {
    const r = el.getBoundingClientRect();
    this.maxRight = Math.max(this.maxRight, r.right - this.ox);
    const items: Item[] = [];
    const box = this.boxPaint(el, cs, r, op);
    if (box) items.push({ k: 'box', box });
    if (cs.visibility !== 'visible') return items;
    const bl = parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    const bt = parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
    const content = {
      x: r.left - this.ox + bl,
      y: r.top - this.oy + bt,
      w: r.width - bl - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
      h: r.height - bt - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom),
    };
    if (content.w <= 0 || content.h <= 0) return items;
    const tag = el.localName;
    if (tag === 'img') {
      const img = el as HTMLImageElement;
      const src = img.currentSrc || img.src;
      if (!src || (img.complete && img.naturalWidth === 0)) {
        this.warn.add('asset-unavailable', 'warning', `Image could not be loaded: ${src || '(no src)'}`, el, 'Check the URL/CORS, or provide the bytes with options.assetResolver');
        return items;
      }
      let asset = this.assetBySrc.get(src);
      if (asset === undefined) {
        asset = this.assets.length;
        this.assets.push({ kind: 'url', src, el: img, w: content.w, h: content.h });
        this.assetBySrc.set(src, asset);
      } else {
        const a = this.assets[asset];
        a.w = Math.max(a.w, content.w);
        a.h = Math.max(a.h, content.h);
      }
      items.push(fitImage(cs, content, img.naturalWidth, img.naturalHeight, asset, op));
      return items;
    }
    if (tag === 'svg' || tag === 'canvas') {
      const asset = this.assets.length;
      this.assets.push({ kind: 'element', el, w: content.w, h: content.h });
      items.push({ k: 'image', ...content, asset, opacity: op });
      return items;
    }
    if (tag === 'input' && /^(checkbox|radio)$/.test((el as HTMLInputElement).type)) {
      items.push(...toggleMark(el as HTMLInputElement, cs, content, op));
      return items;
    }
    if (tag === 'select' && !(el as HTMLSelectElement).multiple) {
      // Dropdown chevron at the right of the content box.
      const color = parseColor(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
      const s = Math.min(8, content.h * 0.5);
      const cx = content.x + content.w - s * 0.9;
      const cy = content.y + content.h / 2;
      items.push({ k: 'path', d: `${f2(cx - s / 2)} ${f2(cy - s / 4)} m ${f2(cx)} ${f2(cy + s / 4)} l ${f2(cx + s / 2)} ${f2(cy - s / 4)} l`, stroke: color, lineWidth: 1.4, opacity: op });
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const value = formValue(el);
      if (value) {
        const fontSize = parseFloat(cs.fontSize);
        const font: FontSpec = { family: cs.fontFamily, weight: parseInt(cs.fontWeight) || 400, style: cs.fontStyle.startsWith('italic') ? 'italic' : 'normal', size: fontSize };
        const fontKey = `${font.style}|${font.weight}|${font.size}|${font.family}`;
        if (!this.fonts.has(fontKey)) this.fonts.set(fontKey, font);
        const color = parseColor(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
        const h = fontSize * 1.25;
        const top = tag === 'textarea' ? content.y : content.y + (content.h - h) / 2;
        const ctx2d = el.ownerDocument.createElement('canvas').getContext('2d');
        let w = value.length * fontSize * 0.5;
        if (ctx2d) {
          ctx2d.font = `${cs.fontStyle} ${cs.fontWeight} ${fontSize}px ${cs.fontFamily}`;
          w = ctx2d.measureText(value).width;
        }
        let x = content.x;
        if (cs.textAlign === 'right' || cs.textAlign === 'end') x = content.x + content.w - w;
        else if (cs.textAlign === 'center') x = content.x + (content.w - w) / 2;
        const t: TextItem = { k: 'text', top, h, baseline: top + h * 0.8, font, fontKey, color, opacity: op, letterSpacing: 0, words: [{ text: value, x, w }], decorations: [] };
        this.texts.push(t);
        items.push({ k: 'clip', ...content }, t, { k: 'unclip' });
      }
      this.warn.add('form-control-approximated', 'info', 'Form controls are drawn as their box and current value (no native widget chrome)', el);
      return items;
    }
    if (tag === 'video' && (el as HTMLVideoElement).poster) {
      const src = new URL((el as HTMLVideoElement).poster, el.baseURI).href;
      const asset = this.assets.length;
      this.assets.push({ kind: 'url', src, el: null, w: content.w, h: content.h });
      items.push({ k: 'image', ...content, asset, opacity: op });
      return items;
    }
    this.warn.add('embedded-content-unsupported', 'warning', `<${tag}> content is not exported`, el, 'Replace it with an image for export');
    return items;
  }

  // ------------------------------------------------------------------ furniture & metrics

  furniture(el: HTMLElement): Furniture {
    this.inFurniture = 'header';
    const node = this.block(el, this.cs(el), 1, []);
    this.inFurniture = null;
    return { items: collectItems(node), top: node.top, height: node.bottom - node.top };
  }

  /** One probe per distinct font: baseline offset from the glyph content-area top. */
  probeBaselines(): void {
    const doc = this.root.ownerDocument;
    const host = doc.createElement('div');
    host.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;line-height:normal;';
    const probes: { key: string; text: Text; mark: HTMLElement }[] = [];
    for (const [key, f] of this.fonts) {
      const d = doc.createElement('div');
      d.style.fontFamily = f.family;
      d.style.fontSize = `${f.size}px`;
      d.style.fontWeight = String(f.weight);
      d.style.fontStyle = f.style;
      const text = doc.createTextNode('Hxg');
      const mark = doc.createElement('span');
      mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;';
      d.append(text, mark);
      host.appendChild(d);
      probes.push({ key, text, mark });
    }
    doc.body.appendChild(host);
    const off = new Map<string, number>();
    for (const p of probes) {
      this.range.selectNodeContents(p.text);
      const top = this.range.getBoundingClientRect().top;
      off.set(p.key, p.mark.getBoundingClientRect().bottom - top);
    }
    host.remove();
    for (const t of this.texts) {
      const o = off.get(t.fontKey);
      if (o != null) t.baseline = t.top + o;
    }
  }
}

// ------------------------------------------------------------------ helpers

const f2 = (n: number) => (Math.round(n * 100) / 100).toString();

/** Checkbox / radio drawn as vector shapes (no glyph needed), in the browser's default style. */
function toggleMark(el: HTMLInputElement, cs: CSSStyleDeclaration, c: { x: number; y: number; w: number; h: number }, op: number): Item[] {
  const s = Math.min(c.w, c.h);
  const x = c.x + (c.w - s) / 2;
  const y = c.y + (c.h - s) / 2;
  const accent = (cs.accentColor && cs.accentColor !== 'auto' ? parseColor(cs.accentColor) : null) ?? { r: 0, g: 0.459, b: 1, a: 1 };
  const grey = { r: 0.46, g: 0.46, b: 0.46, a: 1 };
  const white = { r: 1, g: 1, b: 1, a: 1 };
  const K = 0.5523;
  const radio = el.type === 'radio';
  const circle = (cx: number, cy: number, r: number) =>
    `${f2(cx + r)} ${f2(cy)} m ${f2(cx + r)} ${f2(cy + r * K)} ${f2(cx + r * K)} ${f2(cy + r)} ${f2(cx)} ${f2(cy + r)} c ${f2(cx - r * K)} ${f2(cy + r)} ${f2(cx - r)} ${f2(cy + r * K)} ${f2(cx - r)} ${f2(cy)} c ${f2(cx - r)} ${f2(cy - r * K)} ${f2(cx - r * K)} ${f2(cy - r)} ${f2(cx)} ${f2(cy - r)} c ${f2(cx + r * K)} ${f2(cy - r)} ${f2(cx + r)} ${f2(cy - r * K)} ${f2(cx + r)} ${f2(cy)} c h`;
  const rr = (x0: number, y0: number, w: number, h: number, r: number) =>
    `${f2(x0 + r)} ${f2(y0)} m ${f2(x0 + w - r)} ${f2(y0)} l ${f2(x0 + w)} ${f2(y0)} ${f2(x0 + w)} ${f2(y0 + r)} ${f2(x0 + w)} ${f2(y0 + r)} c ${f2(x0 + w)} ${f2(y0 + h - r)} l ${f2(x0 + w)} ${f2(y0 + h)} ${f2(x0 + w - r)} ${f2(y0 + h)} ${f2(x0 + w - r)} ${f2(y0 + h)} c ${f2(x0 + r)} ${f2(y0 + h)} l ${f2(x0)} ${f2(y0 + h)} ${f2(x0)} ${f2(y0 + h - r)} ${f2(x0)} ${f2(y0 + h - r)} c ${f2(x0)} ${f2(y0 + r)} l ${f2(x0)} ${f2(y0)} ${f2(x0 + r)} ${f2(y0)} ${f2(x0 + r)} ${f2(y0)} c h`;
  const out: Item[] = [];
  if (radio) {
    out.push({ k: 'path', d: circle(x + s / 2, y + s / 2, s / 2 - 0.5), stroke: el.checked ? accent : grey, fill: white, lineWidth: 1, opacity: op });
    if (el.checked) out.push({ k: 'path', d: circle(x + s / 2, y + s / 2, s * 0.25), fill: accent, opacity: op });
  } else if (el.checked) {
    out.push({ k: 'path', d: rr(x, y, s, s, s * 0.15), fill: accent, opacity: op });
    out.push({ k: 'path', d: `${f2(x + s * 0.22)} ${f2(y + s * 0.52)} m ${f2(x + s * 0.42)} ${f2(y + s * 0.72)} l ${f2(x + s * 0.8)} ${f2(y + s * 0.3)} l`, stroke: white, lineWidth: Math.max(1.2, s * 0.14), opacity: op });
  } else {
    out.push({ k: 'path', d: rr(x + 0.5, y + 0.5, s - 1, s - 1, s * 0.15), stroke: grey, fill: white, lineWidth: 1, opacity: op });
  }
  return out;
}

/** Multi-column container: children grouped into columns by x, each read top to bottom. */
export function arrangeColumns(nodes: FNode[]): FNode[] {
  if (nodes.length < 2) return nodes;
  const xOf = (n: FNode) => leftEdge(n);
  const sorted = [...nodes].sort((a, b) => xOf(a) - xOf(b) || a.top - b.top);
  const cols: FNode[][] = [];
  for (const n of sorted) {
    const col = cols.find((c) => Math.abs(xOf(c[0]) - xOf(n)) < 2);
    if (col) col.push(n);
    else cols.push([n]);
  }
  if (cols.length < 2) return arrange(nodes);
  for (const c of cols) c.sort((a, b) => a.top - b.top);
  return [{
    kind: 'parallel',
    top: Math.min(...nodes.map((n) => n.top)),
    bottom: Math.max(...nodes.map((n) => n.bottom)),
    columns: cols,
    brkBefore: 'auto',
    brkAfter: 'auto',
    brkInside: 'auto',
  }];
}

function leftEdge(n: FNode): number {
  if ((n.kind === 'block' || n.kind === 'table' || n.kind === 'row') && n.box) return n.box.x;
  const items = n.kind === 'line' || n.kind === 'leaf' ? n.items : n.kind === 'block' ? collectItems(n) : n.kind === 'parallel' ? n.columns.flat().flatMap(collectItems) : collectItems(n);
  let x = Infinity;
  for (const it of items) {
    if (it.k === 'text' && it.words.length) x = Math.min(x, it.words[0].x);
    else if (it.k === 'box') x = Math.min(x, it.box.x);
    else if (it.k === 'image') x = Math.min(x, it.x);
  }
  return Number.isFinite(x) ? x : 0;
}

function isReplaced(el: Element): boolean {
  if (el.namespaceURI === 'http://www.w3.org/2000/svg') return el.localName === 'svg';
  if (el.namespaceURI !== HTML_NS) return false;
  return /^(img|canvas|video|iframe|object|embed|input|textarea|select|audio|meter|progress)$/.test(el.localName);
}

function isRealTable(el: Element, w: Walker): boolean {
  // CSS tables built from divs work when rows/cells are explicit; anonymous table objects fall back to block layout.
  for (const c of Array.from(el.children)) {
    const d = w.cs(c).display;
    if (d === 'table-cell') return false;
  }
  return true;
}

function transparentBox(r: DOMRect, ox: number, oy: number): BoxPaint {
  const none = { w: 0, style: 'none', color: { r: 0, g: 0, b: 0, a: 0 } };
  return { x: r.left - ox, y: r.top - oy, w: r.width, h: r.height, bg: null, borders: [none, none, none, none], radii: [[0, 0], [0, 0], [0, 0], [0, 0]], opacity: 1 };
}

function applyTransform(s: string, t: string): string {
  if (t === 'uppercase') return s.toUpperCase();
  if (t === 'lowercase') return s.toLowerCase();
  if (t === 'capitalize') return s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

function formValue(el: Element): string {
  if (el.localName === 'select') {
    const s = el as HTMLSelectElement;
    return s.selectedIndex >= 0 ? s.options[s.selectedIndex].text : '';
  }
  const i = el as HTMLInputElement;
  if (el.localName === 'input' && /^(checkbox|radio)$/.test(i.type)) return i.checked ? '✓' : '';
  if (el.localName === 'input' && /^(hidden|file|range|color|button|submit|reset|image)$/.test(i.type)) return el.localName === 'input' && /^(button|submit|reset)$/.test(i.type) ? i.value : '';
  return i.value || '';
}

function fitImage(cs: CSSStyleDeclaration, c: { x: number; y: number; w: number; h: number }, nw: number, nh: number, asset: number, op: number): ImageItem {
  const fit = cs.objectFit || 'fill';
  if (fit === 'fill' || !nw || !nh) return { k: 'image', ...c, asset, opacity: op };
  let s = 1;
  if (fit === 'contain') s = Math.min(c.w / nw, c.h / nh);
  else if (fit === 'cover') s = Math.max(c.w / nw, c.h / nh);
  else if (fit === 'scale-down') s = Math.min(1, Math.min(c.w / nw, c.h / nh));
  const w = nw * s;
  const h = nh * s;
  const [px, py] = (cs.objectPosition || '50% 50%').split(/\s+/);
  const pos = (v: string | undefined, free: number) => (!v ? free / 2 : v.endsWith('%') ? (parseFloat(v) / 100) * free : parseFloat(v) || 0);
  const x = c.x + pos(px, c.w - w);
  const y = c.y + pos(py, c.h - h);
  const overflow = w > c.w + 0.01 || h > c.h + 0.01;
  return { k: 'image', x, y, w, h, clip: overflow ? c : undefined, asset, opacity: op };
}

function parseShadows(s: string) {
  // Chromium serializes as "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px, ..."
  const out: { x: number; y: number; blur: number; spread: number; color: ReturnType<typeof parseColor> & object }[] = [];
  for (const part of s.split(/,(?![^(]*\))/)) {
    if (/inset/.test(part)) continue;
    const colorM = /(rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+\([^)]*\))/i.exec(part);
    const color = colorM ? parseColor(colorM[1]) : { r: 0, g: 0, b: 0, a: 1 };
    const nums = part.replace(colorM?.[1] ?? '', '').trim().split(/\s+/).map(parseFloat).filter((n) => !Number.isNaN(n));
    if (!color || nums.length < 2) continue;
    out.push({ x: nums[0], y: nums[1], blur: nums[2] ?? 0, spread: nums[3] ?? 0, color });
  }
  return out;
}

function computeSpans(rows: RowNode[]): void {
  const own = rows.map((r, i) => Math.max(i, ...r.cells.map((c) => i + Math.max(1, c.rowSpan) - 1)));
  for (let i = 0; i < rows.length; i++) {
    let e = Math.min(own[i], rows.length - 1);
    for (let j = i; j <= e && j < rows.length; j++) e = Math.min(Math.max(e, own[j]), rows.length - 1);
    rows[i].spanEnd = e > i ? e : -1;
  }
}

/** Group inline entries into line boxes by vertical overlap of their glyph/border boxes. */
export function lines(entries: InlineEntry[]): LineNode[] {
  if (!entries.length) return [];
  const sorted = [...entries].sort((a, b) => a.top - b.top || a.seq - b.seq);
  const groups: { es: InlineEntry[]; gt: number; gb: number }[] = [];
  for (const e of sorted) {
    const g = groups[groups.length - 1];
    if (g) {
      const ov = Math.min(e.bottom, g.gb) - Math.max(e.top, g.gt);
      const minH = Math.min(e.bottom - e.top, g.gb - g.gt);
      if (ov > 0 && ov >= 0.5 * minH - 0.01) {
        g.es.push(e);
        g.gt = Math.min(g.gt, e.top);
        g.gb = Math.max(g.gb, e.bottom);
        continue;
      }
    }
    groups.push({ es: [e], gt: e.top, gb: e.bottom });
  }
  return groups.map((g) => {
    g.es.sort((a, b) => a.seq - b.seq);
    const items = g.es.flatMap((e) => e.items);
    const top = Math.min(...g.es.map((e) => e.lt));
    const bottom = Math.max(...g.es.map((e) => e.lb));
    return {
      kind: 'line',
      top,
      bottom: Math.max(bottom, top),
      items,
      imageOnly: items.some((i) => i.k === 'image') && items.every((i) => i.k === 'image' || i.k === 'box'),
      brkBefore: 'auto',
      brkAfter: 'auto',
      brkInside: 'avoid',
    } satisfies LineNode;
  });
}

/**
 * Order children by layout position. Children whose vertical extents overlap (flex rows, grids,
 * floats beside text, absolutely positioned overlays) form a parallel node whose columns fragment
 * independently.
 */
export function arrange(nodes: FNode[]): FNode[] {
  if (nodes.length < 2) return nodes;
  const order = new Map(nodes.map((n, i) => [n, i]));
  const sorted = [...nodes].sort((a, b) => a.top - b.top || order.get(a)! - order.get(b)!);
  const out: FNode[] = [];
  let cluster: FNode[] = [];
  let cBottom = -Infinity;
  const flush = () => {
    if (cluster.length === 1) out.push(cluster[0]);
    else if (cluster.length > 1) out.push(toParallel(cluster, order));
    cluster = [];
  };
  for (const n of sorted) {
    if (cluster.length && n.top < cBottom - 1 && n.bottom - n.top > 0.5) {
      cluster.push(n);
      cBottom = Math.max(cBottom, n.bottom);
    } else {
      flush();
      cluster = [n];
      cBottom = n.bottom;
    }
  }
  flush();
  return out;
}

function toParallel(members: FNode[], order: Map<FNode, number>): ParallelNode {
  const cols: FNode[][] = [];
  for (const m of members) {
    const col = cols.find((c) => c[c.length - 1].bottom <= m.top + 1);
    if (col) col.push(m);
    else cols.push([m]);
  }
  // Paint in DOM order within the cluster.
  cols.sort((a, b) => order.get(a[0])! - order.get(b[0])!);
  const first = members[0];
  const last = members.reduce((a, b) => (b.bottom > a.bottom ? b : a));
  return {
    kind: 'parallel',
    top: Math.min(...members.map((m) => m.top)),
    bottom: Math.max(...members.map((m) => m.bottom)),
    columns: cols,
    brkBefore: first.brkBefore,
    brkAfter: last.brkAfter,
    brkInside: members.some((m) => m.brkInside === 'avoid' && m.kind !== 'line') ? 'avoid' : 'auto',
  };
}

/** Measure a page-furniture element (header/footer) against the export origin. */
export function measureFurniture(win: Window, root: HTMLElement, el: HTMLElement, o: WalkOptions, warn: Warnings): Furniture {
  const w = new Walker(win, root, o, warn);
  const f = w.furniture(el);
  w.probeBaselines();
  return f;
}

/** Flatten a subtree into paint-ordered items (for monolithic content). */
export function collectItems(n: FNode): Item[] {
  const out: Item[] = [];
  const rec = (x: FNode) => {
    switch (x.kind) {
      case 'block':
        if (x.box) out.push({ k: 'box', box: x.box });
        if (x.clip && x.box) out.push({ k: 'clip', x: x.box.x + x.box.borders[3].w, y: x.box.y + x.box.borders[0].w, w: x.box.w - x.box.borders[1].w - x.box.borders[3].w, h: x.box.h - x.box.borders[0].w - x.box.borders[2].w });
        x.children.forEach(rec);
        if (x.clip && x.box) out.push({ k: 'unclip' });
        break;
      case 'line':
      case 'leaf':
        out.push(...x.items);
        break;
      case 'parallel':
        x.columns.forEach((c) => c.forEach(rec));
        break;
      case 'table':
        if (x.box) out.push({ k: 'box', box: x.box });
        x.caption.forEach(rec);
        [...x.head, ...x.body, ...x.foot].forEach(rec);
        break;
      case 'row':
        if (x.box) out.push({ k: 'box', box: x.box });
        for (const c of x.cells) if (c.box) out.push({ k: 'box', box: c.box });
        for (const c of x.cells) c.children.forEach(rec);
        break;
    }
  };
  rec(n);
  return out;
}

export type { LeafNode };
