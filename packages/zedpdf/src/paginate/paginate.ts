/**
 * Content-boundary paginator.
 *
 * Input: the measured fragmentation tree (one continuous layout at the page content width).
 * Output: per-page paint ops. Content is never re-laid out: every fragment is the measured
 * geometry translated by a per-fragment offset (dy). Column positions therefore never drift.
 *
 * Break opportunities (CSS Fragmentation 3 §4.1): between sibling blocks / table rows (Class A),
 * between line boxes (Class B). Rules (§4.4): forced breaks first; then avoid (break-before/after),
 * break-inside: avoid, orphans/widows. When no break satisfies all rules they are relaxed in the
 * spec's order: orphans/widows first, then the avoid rules; as a last resort monolithic content is
 * scaled (images) or sliced. Every page must consume content, otherwise a diagnostic is raised.
 */
import type {
  BlockNode,
  BoxOp,
  CellNode,
  FNode,
  LeafNode,
  LineNode,
  Op,
  ParallelNode,
  RowNode,
  TableNode,
} from '../layout/model.js';

export const EPS = 0.01;

export interface PaginateOptions {
  /** Usable content height per page in CSS px. */
  pageHeight: number;
  repeatTableHeader: boolean;
  oversizedImage: 'scale' | 'slice';
  maxPages?: number;
}

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  el?: Element;
  remedy?: string;
}

/** Break token: where a node resumes on the next page. `null` = finished. */
type Tok = any;

interface Res {
  /** Resume token, or null when the node is complete. */
  tok: Tok | null;
  /** Page y where the placed fragment ends. */
  end: number;
  /** Whether any content of this node was placed on the current page. */
  placed: boolean;
}

interface Env {
  /** Something was placed on this page before this node (so breaking before it is allowed). */
  before: boolean;
  /** Content height available on a fresh page for this node (e.g. page minus repeated thead). */
  fresh: number;
}

const NOTHING = (tok: Tok | null, y: number): Res => ({ tok, end: y, placed: false });

export class PaginationError extends Error {}

export function paginate(root: FNode, opts: PaginateOptions, diag: (d: Diagnostic) => void): Op[][] {
  const p = new Paginator(opts, diag);
  return p.run(root);
}

class Paginator {
  pages: Op[][] = [];
  ops: Op[] = [];
  limit: number;
  constructor(
    private o: PaginateOptions,
    private diag: (d: Diagnostic) => void,
  ) {
    this.limit = o.pageHeight;
  }

  run(root: FNode): Op[][] {
    let tok: Tok | null = null;
    let lastKey = '';
    const max = this.o.maxPages ?? 10000;
    for (let page = 0; ; page++) {
      if (page >= max) throw new PaginationError(`pagination exceeded ${max} pages`);
      this.ops = [];
      const r = this.place(root, tok, 0, { before: false, fresh: this.limit });
      if (!r.placed) {
        throw new PaginationError('pagination stalled: a page could not consume any content');
      }
      this.pages.push(this.ops);
      if (r.tok == null) break;
      const key = JSON.stringify(r.tok);
      if (key === lastKey) throw new PaginationError('pagination stalled: break token did not advance');
      lastKey = key;
      tok = r.tok;
    }
    return this.pages;
  }

  private forcedMemo = new WeakMap<object, boolean>();
  /** Whether a forced break exists between descendants (the whole-node fast path must not skip it). */
  forced(n: FNode): boolean {
    const m = this.forcedMemo.get(n);
    if (m !== undefined) return m;
    let lists: FNode[][] = [];
    if (n.kind === 'block') lists = [n.children];
    else if (n.kind === 'parallel') lists = n.columns;
    else if (n.kind === 'table') lists = [n.caption, n.head, n.body, n.foot];
    else if (n.kind === 'row') lists = n.cells.map((c) => c.children);
    let r = false;
    outer: for (const l of lists) {
      for (let i = 0; i < l.length; i++) {
        if ((i > 0 && l[i].brkBefore === 'page') || (i < l.length - 1 && l[i].brkAfter === 'page') || this.forced(l[i])) {
          r = true;
          break outer;
        }
      }
    }
    this.forcedMemo.set(n, r);
    return r;
  }

  fits(y: number, h: number): boolean {
    return y + h <= this.limit + EPS;
  }

  place(n: FNode, tok: Tok | null, y: number, env: Env): Res {
    switch (n.kind) {
      case 'block':
        return this.block(n, tok, y, env);
      case 'line':
      case 'leaf':
        return this.mono(n, tok, y, env);
      case 'parallel':
        return this.parallel(n, tok, y, env);
      case 'table':
        return this.table(n, tok, y, env);
      case 'row':
        return this.row(n, tok, y, env);
    }
  }

  // ---------------------------------------------------------------- whole-node emission

  emitWhole(n: FNode, dy: number): void {
    switch (n.kind) {
      case 'block': {
        let frag: BoxOp | null = null;
        if (n.box) {
          frag = { op: 'box', box: n.box, y0: n.top + dy, y1: n.bottom + dy, sliceTop: false, sliceBottom: false };
          this.ops.push(frag);
        }
        if (n.clip && frag) this.ops.push({ op: 'clip', frag });
        for (const c of n.children) this.emitWhole(c, dy);
        if (n.clip && frag) this.ops.push({ op: 'unclip' });
        break;
      }
      case 'line':
      case 'leaf':
        this.ops.push({ op: 'items', items: n.items, dy });
        break;
      case 'parallel':
        for (const col of n.columns) for (const c of col) this.emitWhole(c, dy);
        break;
      case 'table':
        if (n.box) this.ops.push({ op: 'box', box: n.box, y0: n.top + dy, y1: n.bottom + dy, sliceTop: false, sliceBottom: false });
        for (const c of n.caption) this.emitWhole(c, dy);
        for (const r of [...n.head, ...n.body, ...n.foot]) this.emitWhole(r, dy);
        break;
      case 'row': {
        if (n.box) this.ops.push({ op: 'box', box: n.box, y0: n.top + dy, y1: n.bottom + dy, sliceTop: false, sliceBottom: false });
        for (const c of n.cells) {
          if (c.box) this.ops.push({ op: 'box', box: c.box, y0: c.top + dy, y1: c.bottom + dy, sliceTop: false, sliceBottom: false });
        }
        for (const c of n.cells) for (const ch of c.children) this.emitWhole(ch, dy);
        break;
      }
    }
  }

  // ---------------------------------------------------------------- blocks

  block(b: BlockNode, tok: Tok | null, y: number, env: Env): Res {
    const h = b.bottom - b.top;
    const start = tok == null;
    if (start && this.fits(y, h) && !this.forced(b)) {
      this.emitWhole(b, y - b.top);
      return { tok: null, end: y + h, placed: true };
    }
    if (start && b.children.length === 0) {
      // Childless box taller than the remaining space: treat as monolithic.
      return this.mono({ kind: 'leaf', top: b.top, bottom: b.bottom, items: b.box ? [{ k: 'box', box: b.box }] : [], imageOnly: false, brkBefore: b.brkBefore, brkAfter: b.brkAfter, brkInside: 'avoid', el: b.el }, null, y, env);
    }
    if (start && b.brkInside === 'avoid' && h <= env.fresh + EPS && env.before) return NOTHING(null, y);
    if (start && b.brkInside === 'avoid' && h > env.fresh + EPS) {
      this.diag({ code: 'break-inside-relaxed', severity: 'info', message: 'break-inside: avoid could not be honored: the element is taller than a page', el: b.el });
    }
    const mark = this.ops.length;
    let frag: BoxOp | null = null;
    if (b.box) {
      frag = { op: 'box', box: b.box, y0: y, y1: y, sliceTop: !start, sliceBottom: true };
      this.ops.push(frag);
    }
    if (b.clip && frag) this.ops.push({ op: 'clip', frag });
    const r = this.flow(b.children, tok, start ? b.top : null, y, env, b);
    if (!r.placed && start && env.before) {
      this.ops.length = mark;
      return NOTHING(null, y);
    }
    if (b.clip && frag) this.ops.push({ op: 'unclip' });
    const finished = r.tok == null;
    let end: number;
    if (finished) {
      const last = b.children[b.children.length - 1];
      end = Math.min(this.limit, r.end + Math.max(0, b.bottom - last.bottom));
    } else {
      end = this.limit;
    }
    if (frag) {
      frag.y1 = end;
      frag.sliceBottom = !finished;
    }
    return { tok: finished ? null : r.tok, end, placed: true };
  }

  /**
   * Place a sequence of siblings. `originTop` is the layout y that maps to page y `y` when the
   * sequence starts fresh (null when continuing at the top of a new page).
   */
  flow(children: FNode[], tok: Tok | null, originTop: number | null, y: number, env: Env, parent?: BlockNode): Res {
    const n = children.length;
    let i: number = tok?.i ?? 0;
    let childTok: Tok | null = tok?.c ?? null;
    const first = i;
    const continuing = tok != null;
    const marks: number[] = [];
    const ends: number[] = [];
    let placedAny = false;
    let lastEnd = y;
    let prev: FNode | null = null;

    for (; i < n; i++, childTok = null) {
      const c = children[i];
      let cy: number;
      if (childTok != null) cy = y;
      else if (prev) cy = lastEnd + (c.top - prev.bottom);
      else if (originTop != null) cy = y + (c.top - originTop);
      else cy = y;

      if (i > first && childTok == null && (children[i - 1].brkAfter === 'page' || c.brkBefore === 'page')) {
        return { tok: { i }, end: lastEnd, placed: placedAny };
      }
      marks[i] = this.ops.length;
      const r = this.place(c, childTok, cy, { before: env.before || placedAny, fresh: env.fresh });
      if (r.placed) {
        placedAny = true;
        ends[i] = r.end;
        if (r.tok == null) {
          lastEnd = r.end;
          prev = c;
          continue;
        }
        return { tok: { i, c: r.tok }, end: r.end, placed: true };
      }
      // Child could not start on this page: choose the best break at or before i.
      const j = this.chooseBreak(children, first, i, continuing, env.before, parent);
      if (j === first && !continuing) {
        this.ops.length = marks[first] ?? this.ops.length;
        return NOTHING(null, y);
      }
      if (j < i) this.ops.length = marks[j];
      return { tok: { i: j }, end: j > first ? ends[j - 1] : y, placed: true };
    }
    return { tok: null, end: lastEnd, placed: placedAny || n === 0 };
  }

  /**
   * Choose a break index j in [first, i] (break before children[j]). Rules are applied in order
   * and relaxed per CSS Fragmentation 3 §4.4: orphans/widows dropped first, then avoid rules.
   * Returning `first` means "break before the whole sequence" and is only offered when the
   * sequence started on this page and something precedes it on the page.
   */
  chooseBreak(children: FNode[], first: number, i: number, continuing: boolean, before: boolean, parent?: BlockNode): number {
    const orphans = parent?.orphans ?? 2;
    const widows = parent?.widows ?? 2;
    const avoidOk = (j: number) => !(children[j - 1].brkAfter === 'avoid' || children[j].brkBefore === 'avoid');
    const linesOk = (j: number) => {
      const a = children[j - 1];
      const b = children[j];
      if (a.kind !== 'line' || b.kind !== 'line') return true;
      let s = j - 1;
      while (s > 0 && children[s - 1].kind === 'line') s--;
      let e = j;
      while (e < children.length && children[e].kind === 'line') e++;
      const beforeCount = j - Math.max(s, first);
      const afterCount = e - j;
      return beforeCount >= orphans && afterCount >= widows;
    };
    const canBreakBeforeAll = !continuing && before;
    const levels: ((j: number) => boolean)[] = [(j) => avoidOk(j) && linesOk(j), (j) => avoidOk(j), () => true];
    for (let lvl = 0; lvl < levels.length; lvl++) {
      for (let j = i; j > first; j--) if (levels[lvl](j)) {
        if (lvl > 0) {
          this.diag({
            code: lvl === 1 ? 'orphans-widows-relaxed' : 'break-avoid-relaxed',
            severity: 'info',
            message: lvl === 1 ? 'orphans/widows could not be satisfied; relaxed per CSS Fragmentation §4.4' : 'break-before/after: avoid could not be satisfied; relaxed per CSS Fragmentation §4.4',
            el: children[j].el,
          });
        }
        return j;
      }
      // At this level nothing inside works; breaking before the whole sequence is a legal option.
      if (canBreakBeforeAll) return first;
    }
    return i > first ? i : first;
  }

  // ---------------------------------------------------------------- monolithic content

  mono(n: LineNode | LeafNode, tok: Tok | null, y: number, env: Env): Res {
    const h = n.bottom - n.top;
    if (tok == null && this.fits(y, h)) {
      this.ops.push({ op: 'items', items: n.items, dy: y - n.top });
      return { tok: null, end: y + h, placed: true };
    }
    if (tok == null && env.before && h <= env.fresh + EPS) return NOTHING(null, y);
    if (tok == null && env.before && h > env.fresh + EPS && y > 0) {
      // Oversized: move it to a fresh page first so it gets the whole page.
      return NOTHING(null, y);
    }
    const avail = this.limit - y;
    if (avail <= EPS) return NOTHING(tok, y);
    if (n.imageOnly && this.o.oversizedImage === 'scale' && tok == null) {
      const s = Math.min(1, avail / h);
      this.diag({
        code: 'oversized-image-scaled',
        severity: 'warning',
        message: `Image is taller than the page area; scaled to ${(s * 100).toFixed(1)}%`,
        el: n.el,
        remedy: "Constrain the image height (e.g. max-height in options.css) or set oversizedImage: 'slice'",
      });
      // Scale around the item's top-left in layout space, then translate.
      this.ops.push({ op: 'items', items: n.items, dy: y - n.top, scale: { s, ox: leftOf(n), oy: n.top } });
      return { tok: null, end: y + h * s, placed: true };
    }
    // Slice the graphical representation (CSS Fragmentation §4.4 last resort).
    const offset: number = tok?.off ?? 0;
    if (offset === 0) {
      this.diag({
        code: 'monolithic-sliced',
        severity: 'warning',
        message: 'Content that cannot be broken (a single line, image or inline-block) is taller than the page and was sliced across pages',
        el: n.el,
        remedy: 'Reduce its height or allow it to break (e.g. display: block instead of inline-block)',
      });
    }
    const show = Math.min(avail, h - offset);
    this.ops.push({ op: 'cliprect', x: -1e4, y, w: 2e4, h: show });
    this.ops.push({ op: 'items', items: n.items, dy: y - (n.top + offset) });
    this.ops.push({ op: 'unclip' });
    const next = offset + show;
    return { tok: next >= h - EPS ? null : { off: next }, end: y + show, placed: true };
  }

  // ---------------------------------------------------------------- parallel flows (flex rows, floats)

  parallel(p: ParallelNode, tok: Tok | null, y: number, env: Env): Res {
    const h = p.bottom - p.top;
    if (tok == null && this.fits(y, h) && !this.forced(p)) {
      this.emitWhole(p, y - p.top);
      return { tok: null, end: y + h, placed: true };
    }
    if (tok == null && p.brkInside === 'avoid' && h <= env.fresh + EPS && env.before) return NOTHING(null, y);
    const mark = this.ops.length;
    const toks: (Tok | 'done' | null)[] = tok?.cols ?? p.columns.map(() => null);
    const next: (Tok | 'done' | null)[] = [];
    let any = false;
    let end = y;
    let allDone = true;
    p.columns.forEach((col, k) => {
      const t = toks[k];
      if (t === 'done') {
        next.push('done');
        return;
      }
      const r = this.flow(col, t, tok == null ? p.top : null, y, { before: true, fresh: env.fresh });
      if (r.placed) any = true;
      end = Math.max(end, r.end);
      if (r.tok == null && (r.placed || col.length === 0)) next.push('done');
      else {
        next.push(r.placed ? r.tok : t);
        allDone = false;
      }
    });
    if (!any) {
      this.ops.length = mark;
      if (env.before) return NOTHING(tok, y);
      // At the top of a page nothing fits: force progress column by column.
      allDone = true;
      next.length = 0;
      p.columns.forEach((col, k) => {
        const t = toks[k];
        if (t === 'done') return void next.push('done');
        const r = this.flow(col, t, tok == null ? p.top : null, y, { before: false, fresh: env.fresh });
        end = Math.max(end, r.end);
        if (r.tok == null) next.push('done');
        else {
          next.push(r.tok);
          allDone = false;
        }
      });
    }
    return { tok: allDone ? null : { cols: next }, end, placed: true };
  }

  // ---------------------------------------------------------------- tables

  table(t: TableNode, tok: Tok | null, y: number, env: Env): Res {
    const h = t.bottom - t.top;
    if (tok == null && this.fits(y, h) && !this.forced(t)) {
      this.emitWhole(t, y - t.top);
      return { tok: null, end: y + h, placed: true };
    }
    const head = t.head;
    const headH = head.length ? head[head.length - 1].bottom - head[0].top : 0;
    const firstBody = t.body[0] ?? t.foot[0];
    const headGap = head.length && firstBody ? Math.max(0, firstBody.top - head[head.length - 1].bottom) : 0;
    let repeat = this.o.repeatTableHeader && head.length > 0;
    if (repeat && headH + headGap > this.limit / 4) {
      repeat = false;
      if (!tok) {
        this.diag({
          code: 'table-header-not-repeated',
          severity: 'warning',
          message: `Table header is ${headH.toFixed(0)}px tall, more than a quarter of the page (CSS Tables 3 §6.2); it is not repeated so body rows can fit`,
          el: t.el,
          remedy: 'Shorten the <thead> or move tall heading content out of the table',
        });
      }
    }
    const freshBody = this.limit - (repeat ? headH + headGap : 0);
    const start = tok == null;
    const mark = this.ops.length;
    const frag: BoxOp | null = t.box ? { op: 'box', box: t.box, y0: y, y1: y, sliceTop: !start, sliceBottom: true } : null;
    if (frag) this.ops.push(frag);

    let cur = y;
    let prev: RowNode | FNode | null = null;
    if (start) {
      const firstSection = t.caption[0] ?? head[0] ?? t.body[0] ?? t.foot[0];
      if (!firstSection) return { tok: null, end: y, placed: true };
      cur = y + (firstSection.top - t.top);
      for (const c of t.caption) {
        if (prev) cur += c.top - prev.bottom;
        this.emitWhole(c, cur - c.top);
        cur += c.bottom - c.top;
        prev = c;
      }
      for (const r of head) {
        if (prev) cur += r.top - prev.bottom;
        this.emitWhole(r, cur - r.top);
        cur += r.bottom - r.top;
        prev = r;
      }
    } else if (repeat) {
      let hp: RowNode | null = null;
      for (const r of head) {
        if (hp) cur += r.top - hp.bottom;
        this.emitWhole(r, cur - r.top);
        cur += r.bottom - r.top;
        hp = r;
      }
      cur += headGap;
    }

    const phase: 'body' | 'foot' = tok?.ph ?? 'body';
    let i: number = tok?.i ?? 0;
    let rowTok: Tok | null = tok?.r ?? null;
    let bodyPlaced = false;
    let result: Res | null = null;

    const placeRows = (list: RowNode[], ph: 'body' | 'foot', startIdx: number, startTok: Tok | null): Res | null => {
      let k = startIdx;
      let rt = startTok;
      for (; k < list.length; k++, rt = null) {
        const row = list[k];
        let cy: number;
        if (rt != null) cy = cur;
        else if (prev) cy = cur + (row.top - prev.bottom);
        else cy = cur;
        if (rt == null && bodyPlaced && k > 0 && (list[k - 1].brkAfter === 'page' || row.brkBefore === 'page')) {
          return { tok: { ph, i: k }, end: cur, placed: true };
        }
        // Rowspan group: keep spanned rows together when the group fits on a fresh page.
        if (rt == null && row.spanEnd > k) {
          const last = list[row.spanEnd];
          const gh = last.bottom - row.top;
          if (this.fits(cy, gh)) {
            for (let g = k; g <= row.spanEnd; g++) {
              const rr = list[g];
              const gy = cy + (rr.top - row.top);
              this.emitWhole(rr, gy - rr.top);
            }
            cur = cy + gh;
            prev = last;
            bodyPlaced = true;
            k = row.spanEnd;
            continue;
          }
          if (gh <= freshBody + EPS && (bodyPlaced || env.before)) {
            if (!bodyPlaced) return null; // header alone → move table
            return { tok: { ph, i: k }, end: cur, placed: true };
          }
          this.diag({
            code: 'rowspan-split',
            severity: 'warning',
            message: 'A rowspan group is taller than a page and crosses a page boundary; the spanning cell is painted only in its first fragment and may be clipped',
            el: row.el,
            remedy: 'Avoid rowspan across long content, or split the group into separate rows',
          });
        }
        const r = this.row(row, rt, cy, { before: true, fresh: freshBody });
        if (!r.placed) {
          if (bodyPlaced) return { tok: { ph, i: k, r: rt }, end: cur, placed: true };
          // Never leave a header alone at the bottom of a page: move the whole table.
          if (start && env.before) return null;
          // First body content of this page cannot be deferred any further: force-split it.
          const forced = this.row(row, rt, cy, { before: false, fresh: freshBody });
          cur = forced.end;
          prev = row;
          bodyPlaced = true;
          if (forced.tok != null) return { tok: { ph, i: k, r: forced.tok }, end: forced.end, placed: true };
          continue;
        }
        bodyPlaced = true;
        cur = r.end;
        prev = row;
        if (r.tok != null) return { tok: { ph, i: k, r: r.tok }, end: r.end, placed: true };
      }
      return { tok: null, end: cur, placed: true };
    };

    if (phase === 'body') {
      result = placeRows(t.body, 'body', i, rowTok);
      if (result === null) {
        this.ops.length = mark;
        return NOTHING(null, y);
      }
      if (result.tok == null && t.foot.length) {
        // Footer (e.g. invoice totals) is placed once, after the last body row.
        const footRes = placeRows(t.foot, 'foot', 0, null);
        if (footRes === null) {
          this.ops.length = mark;
          return NOTHING(null, y);
        }
        result = footRes;
      }
    } else {
      result = placeRows(t.foot, 'foot', i, rowTok);
      if (result === null) {
        this.ops.length = mark;
        return NOTHING(null, y);
      }
    }
    i = 0;
    rowTok = null;

    const finished = result.tok == null;
    let end = result.end;
    if (finished) {
      const lastRow = t.foot[t.foot.length - 1] ?? t.body[t.body.length - 1] ?? head[head.length - 1];
      if (lastRow) end = Math.min(this.limit, end + Math.max(0, t.bottom - lastRow.bottom));
    }
    if (frag) {
      frag.y1 = end;
      frag.sliceBottom = !finished;
    }
    return { tok: result.tok, end, placed: true };
  }

  /**
   * Rows are kept intact when they fit on a fresh page (an exact fit stays on the current page).
   * A row taller than a fresh page is split at measured line boundaries, each cell tracking its
   * own progress; the next row starts only after every cell has finished.
   */
  row(row: RowNode, tok: Tok | null, y: number, env: Env): Res {
    const h = row.bottom - row.top;
    if (tok == null && this.fits(y, h) && !this.forced(row)) {
      this.emitWhole(row, y - row.top);
      return { tok: null, end: y + h, placed: true };
    }
    if (tok == null && h <= env.fresh + EPS && env.before) return NOTHING(null, y);
    if (tok == null && row.brkInside === 'avoid' && env.before && y > 0) return NOTHING(null, y);
    const start = tok == null;
    const mark = this.ops.length;
    const rowFrag: BoxOp | null = row.box ? { op: 'box', box: row.box, y0: y, y1: y, sliceTop: !start, sliceBottom: true } : null;
    if (rowFrag) this.ops.push(rowFrag);
    const cellFrags: (BoxOp | null)[] = row.cells.map((c) => {
      if (!c.box) return null;
      const f: BoxOp = { op: 'box', box: c.box, y0: y, y1: y, sliceTop: !start, sliceBottom: true };
      this.ops.push(f);
      return f;
    });
    const toks: (Tok | 'done' | null)[] = tok?.cells ?? row.cells.map(() => null);
    const next: (Tok | 'done' | null)[] = [];
    let any = false;
    let allDone = true;
    let end = y;
    const cellEnds: number[] = [];
    row.cells.forEach((cell: CellNode, k) => {
      const t = toks[k];
      if (t === 'done') {
        next.push('done');
        cellEnds.push(y);
        return;
      }
      if (cell.children.length === 0) {
        next.push('done');
        cellEnds.push(y);
        return;
      }
      const r = this.flow(cell.children, t, t == null ? row.top : null, y, { before: true, fresh: env.fresh });
      if (r.placed) any = true;
      let cellEnd = r.end;
      if (r.tok == null && r.placed) {
        cellEnd = r.end + cell.padBottom;
        next.push('done');
      } else {
        next.push(r.placed ? r.tok : t);
        allDone = false;
      }
      cellEnds.push(cellEnd);
      end = Math.max(end, cellEnd);
    });
    if (!any) {
      this.ops.length = mark;
      if (env.before) return NOTHING(tok, y);
      // Top of page and still nothing fits (a single line taller than the page): force.
      return this.forceRow(row, tok, y, env);
    }
    end = Math.min(Math.max(end, y), this.limit);
    if (allDone && start) end = Math.max(end, Math.min(y + h, this.limit));
    if (rowFrag) {
      rowFrag.y1 = end;
      rowFrag.sliceBottom = !allDone;
    }
    for (const f of cellFrags) {
      if (!f) continue;
      f.y1 = end;
      f.sliceBottom = !allDone;
    }
    return { tok: allDone ? null : { cells: next }, end, placed: true };
  }

  private forceRow(row: RowNode, tok: Tok | null, y: number, env: Env): Res {
    const toks: (Tok | 'done' | null)[] = tok?.cells ?? row.cells.map(() => null);
    const next: (Tok | 'done' | null)[] = [];
    let end = y;
    let allDone = true;
    row.cells.forEach((cell, k) => {
      const t = toks[k];
      if (t === 'done' || cell.children.length === 0) return void next.push('done');
      const r = this.flow(cell.children, t, t == null ? row.top : null, y, { before: false, fresh: env.fresh });
      end = Math.max(end, r.end);
      if (r.tok == null) next.push('done');
      else {
        next.push(r.tok);
        allDone = false;
      }
    });
    return { tok: allDone ? null : { cells: next }, end: Math.min(end, this.limit), placed: true };
  }
}

function leftOf(n: LineNode | LeafNode): number {
  let x = Infinity;
  for (const it of n.items) {
    if (it.k === 'image' || it.k === 'clip') x = Math.min(x, it.x);
    else if (it.k === 'box') x = Math.min(x, it.box.x);
    else if (it.k === 'text' && it.words.length) x = Math.min(x, it.words[0].x);
  }
  return Number.isFinite(x) ? x : 0;
}
