import { describe, expect, it } from 'vitest';
import { paginate, type Diagnostic } from '../src/paginate/paginate';
import type { BlockNode, CellNode, FNode, LeafNode, LineNode, Op, RowNode, TableNode, TextItem } from '../src/layout/model';

// ---------------------------------------------------------------- tiny tree builders
let cursor = 0;
const base = { brkBefore: 'auto' as const, brkAfter: 'auto' as const, brkInside: 'auto' as const };
function text(id: string, top: number, h: number): TextItem {
  return {
    k: 'text', top, h, baseline: top + h * 0.8, font: { family: 'x', weight: 400, style: 'normal', size: 10 }, fontKey: 'x',
    color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, letterSpacing: 0, words: [{ text: id, x: 0, w: 10 }], decorations: [],
  };
}
function line(id: string, top: number, h = 20): LineNode {
  return { kind: 'line', top, bottom: top + h, items: [text(id, top, h)], imageOnly: false, ...base };
}
function lines(prefix: string, top: number, n: number, h = 20): LineNode[] {
  return Array.from({ length: n }, (_, i) => line(`${prefix}${i}`, top + i * h, h));
}
function block(children: FNode[], extra: Partial<BlockNode> = {}): BlockNode {
  const top = children.length ? children[0].top : 0;
  const bottom = children.length ? children[children.length - 1].bottom : 0;
  return { kind: 'block', top, bottom, box: null, clip: false, children, orphans: 1, widows: 1, ...base, ...extra };
}
function cell(top: number, children: FNode[], bottom: number): CellNode {
  return { box: null, top, bottom, padBottom: 0, children, rowSpan: 1, colSpan: 1 };
}
function row(id: string, top: number, h: number, extraCells: FNode[][] = []): RowNode {
  const cells = [cell(top, [line(id, top, h)], top + h), ...extraCells.map((c) => cell(top, c, top + h))];
  return { kind: 'row', top, bottom: top + h, box: null, cells, spanEnd: -1, ...base };
}
function table(top: number, headH: number, rowHs: number[], footH = 0): TableNode {
  let y = top;
  const head = headH ? [row('HEAD', y, headH)] : [];
  y += headH;
  const body = rowHs.map((h, i) => {
    const r = row(`R${i}`, y, h);
    y += h;
    return r;
  });
  const foot = footH ? [row('FOOT', y, footH)] : [];
  y += footH;
  return { kind: 'table', top, bottom: y, box: null, caption: [], head, body, foot, ...base };
}
/** Words drawn per page, in order. */
function words(pages: Op[][]): string[][] {
  return pages.map((ops) => ops.flatMap((o) => (o.op === 'items' ? o.items.flatMap((it) => (it.k === 'text' ? it.words.map((w) => w.text) : [])) : [])));
}
/** Page y (top) for each drawn word id. */
function positions(pages: Op[][]): Map<string, { page: number; y: number }[]> {
  const m = new Map<string, { page: number; y: number }[]>();
  pages.forEach((ops, page) => {
    for (const o of ops) if (o.op === 'items') for (const it of o.items) if (it.k === 'text') for (const w of it.words) {
      const arr = m.get(w.text) ?? [];
      arr.push({ page, y: it.top + o.dy });
      m.set(w.text, arr);
    }
  });
  return m;
}
function run(root: FNode, pageHeight = 100, extra = {}) {
  const diags: Diagnostic[] = [];
  const pages = paginate(root, { pageHeight, repeatTableHeader: true, oversizedImage: 'scale', ...extra }, (d) => diags.push(d));
  return { pages, w: words(pages), diags, pos: positions(pages) };
}

// ---------------------------------------------------------------- tests
describe('rows', () => {
  it('an exact-fit row stays on the current page', () => {
    const { w } = run(block([table(0, 0, [25, 25, 25, 25, 25])]));
    expect(w).toEqual([['R0', 'R1', 'R2', 'R3'], ['R4']]);
  });

  it('a row just over the remaining space moves intact to the next page', () => {
    const { w } = run(block([table(0, 0, [25, 25, 25, 25.5])]));
    expect(w).toEqual([['R0', 'R1', 'R2'], ['R3']]);
  });

  it('reserves space for the repeated thead before choosing rows', () => {
    const { w, pos } = run(block([table(0, 10, [30, 30, 30, 30, 30, 30])]));
    expect(w).toEqual([
      ['HEAD', 'R0', 'R1', 'R2'],
      ['HEAD', 'R3', 'R4', 'R5'],
    ]);
    expect(pos.get('R3')![0]).toEqual({ page: 1, y: 10 });
  });

  it('never leaves a header alone at the bottom of a page', () => {
    const intro = block(lines('P', 0, 4)); // 80px
    const t = table(80, 10, [30, 30]); // head fits (90) but no row does
    const { w } = run(block([intro, t]));
    expect(w[0]).toEqual(['P0', 'P1', 'P2', 'P3']);
    expect(w[1]).toEqual(['HEAD', 'R0', 'R1']);
  });

  it('splits a row taller than a page at line boundaries, each cell independently', () => {
    const top = 0;
    const desc = lines('D', top, 8, 30); // 240px tall description cell
    const amount = [line('AMOUNT', top, 20)];
    const r: RowNode = { kind: 'row', top, bottom: top + 240, box: null, cells: [cell(top, desc, top + 240), cell(top, amount, top + 240)], spanEnd: -1, ...base };
    const t: TableNode = { kind: 'table', top, bottom: top + 240 + 20, box: null, caption: [], head: [], body: [r, row('NEXT', top + 240, 20)], foot: [], ...base };
    const { w, pos } = run(block([t]));
    // 3 lines of 30px per page (90 <= 100)
    expect(w[0]).toEqual(['D0', 'D1', 'D2', 'AMOUNT']);
    expect(w[1]).toEqual(['D3', 'D4', 'D5']);
    expect(w[2]).toEqual(['D6', 'D7', 'NEXT']);
    expect(pos.get('AMOUNT')!.length).toBe(1);
    expect(pos.get('NEXT')![0].y).toBeCloseTo(60);
  });

  it('a row taller than a page with break-inside: avoid moves to a fresh page before splitting', () => {
    const tall = lines('D', 40, 6, 30); // 180px row starting at y=40
    const r: RowNode = { kind: 'row', top: 40, bottom: 220, box: null, cells: [cell(40, tall, 220)], spanEnd: -1, ...base, brkInside: 'avoid' };
    const t: TableNode = { kind: 'table', top: 0, bottom: 220, box: null, caption: [], head: [], body: [row('R0', 0, 40), r], foot: [], ...base };
    const { w } = run(block([t]));
    expect(w[0]).toEqual(['R0']);
    expect(w[1]).toEqual(['D0', 'D1', 'D2']);
    expect(w[2]).toEqual(['D3', 'D4', 'D5']);
  });

  it('a full-page row (exactly the page height) occupies one page', () => {
    const { w } = run(block([table(0, 0, [40, 100, 40])]));
    expect(w).toEqual([['R0'], ['R1'], ['R2']]);
  });

  it('keeps rowspan groups together when they fit on a fresh page', () => {
    const t = table(0, 0, [40, 30, 30]);
    t.body[1].spanEnd = 2; // R1 spans into R2 → 60px group, only 60 left → fits exactly
    const t2 = table(0, 0, [50, 30, 30]);
    t2.body[1].spanEnd = 2; // group 60 > remaining 50 → moves
    expect(run(block([t])).w).toEqual([['R0', 'R1', 'R2']]);
    expect(run(block([t2])).w).toEqual([['R0'], ['R1', 'R2']]);
  });

  it('places the tfoot totals once, after the last body row', () => {
    const { w } = run(block([table(0, 10, [30, 30, 30, 30], 25)]));
    const all = w.flat();
    expect(all.filter((x) => x === 'FOOT').length).toBe(1);
    expect(w[w.length - 1].includes('FOOT')).toBe(true);
  });

  it('200 rows: every row exactly once, in order, header on every page', () => {
    const { w } = run(block([table(0, 10, Array(200).fill(17))]), 1000);
    const rows = w.flat().filter((x) => x.startsWith('R'));
    expect(rows).toEqual(Array.from({ length: 200 }, (_, i) => `R${i}`));
    for (const p of w) expect(p[0]).toBe('HEAD');
  });

  it('does not repeat a header taller than a quarter page', () => {
    const { w, diags } = run(block([table(0, 30, [40, 40, 40])]));
    expect(w[1][0]).not.toBe('HEAD');
    expect(diags.some((d) => d.code === 'table-header-not-repeated')).toBe(true);
  });
});

describe('blocks and lines', () => {
  it('honors forced breaks and produces no blank trailing page', () => {
    const a = block(lines('A', 0, 2), { brkAfter: 'page' });
    const b = block(lines('B', 40, 1), { brkAfter: 'page' });
    const { w } = run(block([a, b]));
    expect(w).toEqual([['A0', 'A1'], ['B0']]);
  });

  it('ignores a forced break before the very first content (no leading blank page)', () => {
    const a = block(lines('A', 0, 2), { brkBefore: 'page' });
    expect(run(block([a])).w).toEqual([['A0', 'A1']]);
  });

  it('keeps a heading with the next block (break-after: avoid)', () => {
    const intro = block(lines('P', 0, 3)); // 60
    const h = block([line('H', 60, 20)], { brkAfter: 'avoid' }); // 80
    const para = block(lines('Q', 80, 3), { brkInside: 'avoid' }); // 140
    const { w } = run(block([intro, h, para]));
    expect(w[0]).toEqual(['P0', 'P1', 'P2']);
    expect(w[1]).toEqual(['H', 'Q0', 'Q1', 'Q2']);
  });

  it('honors widows by moving the break earlier', () => {
    const p = block(lines('L', 0, 6), { orphans: 2, widows: 2 }); // 120: 5 lines fit
    const { w } = run(block([p]));
    expect(w).toEqual([['L0', 'L1', 'L2', 'L3'], ['L4', 'L5']]);
  });

  it('honors orphans by moving the whole paragraph', () => {
    const intro = block(lines('P', 0, 4)); // 80
    const p = block(lines('L', 80, 3), { orphans: 2, widows: 1 }); // only 1 line would fit
    const { w } = run(block([intro, p]));
    expect(w).toEqual([['P0', 'P1', 'P2', 'P3'], ['L0', 'L1', 'L2']]);
  });

  it('keeps a totals block together when it fits on one page', () => {
    const items = block(lines('I', 0, 4)); // 80
    const totals = block(lines('T', 80, 3), { brkInside: 'avoid' });
    const { w } = run(block([items, totals]));
    expect(w).toEqual([['I0', 'I1', 'I2', 'I3'], ['T0', 'T1', 'T2']]);
  });

  it('splits a totals block taller than a page with a diagnostic', () => {
    const totals = block(lines('T', 0, 7), { brkInside: 'avoid' });
    const { w, diags } = run(block([totals]));
    expect(w.flat()).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
    expect(diags.some((d) => d.code === 'break-inside-relaxed')).toBe(true);
  });

  it('scales an oversized image to fit and reports it', () => {
    const img: LeafNode = { kind: 'leaf', top: 0, bottom: 250, items: [text('IMG', 0, 250)], imageOnly: true, ...base };
    const { pages, diags } = run(block([img]));
    expect(pages.length).toBe(1);
    const op = pages[0].find((o) => o.op === 'items') as Extract<Op, { op: 'items' }>;
    expect(op.scale!.s).toBeCloseTo(0.4);
    expect(diags[0].code).toBe('oversized-image-scaled');
  });

  it('slices oversized monolithic content and terminates', () => {
    const leaf: LeafNode = { kind: 'leaf', top: 0, bottom: 250, items: [text('BIG', 0, 250)], imageOnly: false, ...base };
    const { pages } = run(block([leaf]));
    expect(pages.length).toBe(3);
  });

  it('parallel columns (flex row) fragment independently', () => {
    const left = lines('A', 0, 8);
    const right = lines('B', 0, 2);
    const par: FNode = { kind: 'parallel', top: 0, bottom: 160, columns: [left, right], ...base };
    const { w } = run(block([par]));
    expect(w.flat().filter((x) => x.startsWith('B'))).toEqual(['B0', 'B1']);
    expect(w.flat().filter((x) => x.startsWith('A'))).toEqual(left.map((_, i) => `A${i}`));
  });

  it('terminates on pathological input: many tall lines', () => {
    const p = block(Array.from({ length: 50 }, (_, i) => line(`X${i}`, i * 150, 150)));
    const { w, pages } = run(block([p]));
    // Each 150px line moves to a fresh page, then is sliced over two pages (100 + 50).
    expect(pages.length).toBe(100);
    expect(new Set(w.flat()).size).toBe(50);
  });
});
