/**
 * Measured layout model. All geometry is in CSS px, relative to the export root:
 * x = 0 at the page content-area left edge, y = 0 at the export root's border-box top.
 * Values keep full fractional precision; rounding only happens when the PDF is serialized.
 */

export interface RGBA {
  r: number; // 0..1
  g: number;
  b: number;
  a: number; // 0..1
}

export interface BorderSide {
  w: number;
  style: string; // solid | dashed | dotted | double | ...
  color: RGBA;
}

export interface BoxPaint {
  x: number;
  y: number;
  w: number;
  h: number;
  bg: RGBA | null;
  /** top, right, bottom, left */
  borders: [BorderSide, BorderSide, BorderSide, BorderSide];
  /** corner radii [tl, tr, br, bl] as [rx, ry] */
  radii: [number, number][];
  opacity: number;
  shadows?: BoxShadow[];
}

export interface BoxShadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: RGBA;
}

export interface FontSpec {
  /** Raw computed font-family list. */
  family: string;
  weight: number;
  style: 'normal' | 'italic' | 'oblique';
  size: number;
}

export interface Word {
  text: string;
  x: number;
  w: number;
  /** Set when this word must be drawn with the complex-script fallback. */
  complex?: boolean;
  rasterId?: number;
  rasterRect?: { x: number; y: number; w: number; h: number };
}

export interface Decoration {
  kind: 'underline' | 'line-through' | 'overline';
  color: RGBA;
  thickness: number | null;
  style: string;
}

export interface TextItem {
  k: 'text';
  /** Glyph content-area rect top / height (from Range geometry). */
  top: number;
  h: number;
  /** Filled after the metrics probe: baseline y. */
  baseline: number;
  font: FontSpec;
  fontKey: string;
  color: RGBA;
  opacity: number;
  letterSpacing: number;
  words: Word[];
  decorations: Decoration[];
  /** Furniture token ('page' | 'pages') replaced with numbers at paint time. */
  token?: 'page' | 'pages';
  /** Absolute URL when the text is inside <a href>: becomes a clickable link annotation. */
  href?: string;
  /** Index of the font chain resolved for this item's font spec. */
  chain?: number;
}

export interface ImageItem {
  k: 'image';
  /** Rect the image is drawn into (after object-fit). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Clip rect (content box) when object-fit overflows it. */
  clip?: { x: number; y: number; w: number; h: number };
  /** Key into the image registry. */
  asset: number;
  opacity: number;
}

export interface BoxItem {
  k: 'box';
  box: BoxPaint;
}

export interface ClipItem {
  k: 'clip';
  x: number;
  y: number;
  w: number;
  h: number;
  radii?: [number, number][];
}

export interface UnclipItem {
  k: 'unclip';
}

/** Vector shape in layout coordinates (CSS px, y down): form-control marks, list markers. */
export interface PathItem {
  k: 'path';
  /** PDF path construction operators with absolute layout coordinates (m, l, c, re, h). */
  d: string;
  fill?: RGBA;
  stroke?: RGBA;
  lineWidth?: number;
  opacity: number;
}

export type Item = TextItem | ImageItem | BoxItem | ClipItem | UnclipItem | PathItem;

export type Brk = 'auto' | 'avoid' | 'page';

export interface NodeBase {
  top: number;
  bottom: number;
  brkBefore: Brk;
  brkAfter: Brk;
  brkInside: 'auto' | 'avoid';
  /** Element descriptor for diagnostics. */
  el?: Element;
}

export interface BlockNode extends NodeBase {
  kind: 'block';
  box: BoxPaint | null;
  clip: boolean;
  children: FNode[];
  orphans: number;
  widows: number;
}

export interface LineNode extends NodeBase {
  kind: 'line';
  items: Item[];
  imageOnly: boolean;
}

export interface LeafNode extends NodeBase {
  kind: 'leaf';
  items: Item[];
  imageOnly: boolean;
}

export interface ParallelNode extends NodeBase {
  kind: 'parallel';
  columns: FNode[][];
}

export interface CellNode {
  box: BoxPaint | null;
  top: number;
  bottom: number;
  padBottom: number;
  children: FNode[];
  rowSpan: number;
  colSpan: number;
  el?: Element;
}

export interface RowNode extends NodeBase {
  kind: 'row';
  box: BoxPaint | null;
  cells: CellNode[];
  /** Index (within its row list) of the last row covered by a rowspan starting at or before this row. */
  spanEnd: number;
}

export interface TableNode extends NodeBase {
  kind: 'table';
  box: BoxPaint | null;
  caption: FNode[];
  head: RowNode[];
  body: RowNode[];
  foot: RowNode[];
  /** Layout y of the first section (thead or first row) relative to the table top. */
}

export type FNode = BlockNode | LineNode | LeafNode | ParallelNode | TableNode | RowNode;

/** Paint operations produced by the paginator (page coordinates: y = 0 at content-area top). */
export type Op =
  | {
      op: 'box';
      box: BoxPaint;
      y0: number;
      y1: number;
      sliceTop: boolean;
      sliceBottom: boolean;
    }
  | { op: 'items'; items: Item[]; dy: number; scale?: { s: number; ox: number; oy: number } }
  | { op: 'clip'; frag: Extract<Op, { op: 'box' }> }
  | { op: 'cliprect'; x: number; y: number; w: number; h: number }
  | { op: 'unclip' };

export type BoxOp = Extract<Op, { op: 'box' }>;
