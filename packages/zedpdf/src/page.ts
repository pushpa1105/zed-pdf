/**
 * Page model: one source of truth for paper size, margins, usable area and the CSS px → PDF pt
 * conversion (1 CSS px = 1/96 in = 0.75 pt). Fractional values are kept until serialization.
 */
import type { Length, PageOptions } from './types.js';

export const PX_TO_PT = 0.75;

const PAPER_MM: Record<string, [number, number]> = {
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  LETTER: [215.9, 279.4],
  LEGAL: [215.9, 355.6],
};

export function lengthToPx(v: Length | undefined, fallback: number): number {
  if (v == null) return fallback;
  if (typeof v === 'number') return v;
  const m = /^\s*(-?[\d.]+)\s*(mm|cm|in|pt|px|pc)?\s*$/i.exec(v);
  if (!m) throw new TypeError(`zedpdf: invalid length '${v}'`);
  const n = parseFloat(m[1]);
  switch ((m[2] || 'px').toLowerCase()) {
    case 'mm':
      return (n * 96) / 25.4;
    case 'cm':
      return (n * 960) / 25.4;
    case 'in':
      return n * 96;
    case 'pt':
      return (n * 96) / 72;
    case 'pc':
      return n * 16;
    default:
      return n;
  }
}

export interface PageModel {
  /** Paper size in CSS px. */
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  /** Usable content box in CSS px (before header/footer furniture is reserved). */
  contentWidth: number;
  contentHeight: number;
  /** CSS keyword for @page size, e.g. "210mm 297mm". */
  cssSize: string;
  cssMargin: string;
}

export function pageModel(o: PageOptions): PageModel {
  let w: number;
  let h: number;
  const f = o.format ?? 'A4';
  if (typeof f === 'string') {
    const mm = PAPER_MM[f.toUpperCase()];
    if (!mm) throw new TypeError(`zedpdf: unknown paper format '${f}'`);
    w = (mm[0] * 96) / 25.4;
    h = (mm[1] * 96) / 25.4;
  } else {
    w = lengthToPx(f.width, 0);
    h = lengthToPx(f.height, 0);
  }
  if ((o.orientation === 'landscape') !== w > h) [w, h] = [h, w];
  const dm = lengthToPx('10mm', 0);
  const m = o.margin;
  const margin =
    m == null || typeof m === 'number' || typeof m === 'string'
      ? { top: lengthToPx(m as Length, dm), right: lengthToPx(m as Length, dm), bottom: lengthToPx(m as Length, dm), left: lengthToPx(m as Length, dm) }
      : { top: lengthToPx(m.top, dm), right: lengthToPx(m.right, dm), bottom: lengthToPx(m.bottom, dm), left: lengthToPx(m.left, dm) };
  const contentWidth = w - margin.left - margin.right;
  const contentHeight = h - margin.top - margin.bottom;
  if (contentWidth < 50 || contentHeight < 50) throw new TypeError('zedpdf: margins leave no usable page area');
  const px = (n: number) => `${+(n * 0.75).toFixed(4)}pt`;
  return {
    width: w,
    height: h,
    margin,
    contentWidth,
    contentHeight,
    cssSize: `${px(w)} ${px(h)}`,
    cssMargin: `${px(margin.top)} ${px(margin.right)} ${px(margin.bottom)} ${px(margin.left)}`,
  };
}
