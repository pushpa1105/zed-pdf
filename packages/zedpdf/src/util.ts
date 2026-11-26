import type { RGBA } from './layout/model.js';
import { ZedPdfError, type ExportWarning, type WarningSeverity } from './types.js';

const colorCache = new Map<string, RGBA | null>();
let probeCtx: CanvasRenderingContext2D | null = null;

/** Parse a computed CSS color into sRGB 0..1. Modern color spaces are converted via a canvas pixel. */
export function parseColor(s: string): RGBA | null {
  if (!s || s === 'transparent') return null;
  const hit = colorCache.get(s);
  if (hit !== undefined) return hit;
  let c: RGBA | null = null;
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    c = { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a };
  } else {
    // oklch(), color(display-p3 …), lab() … → let the browser convert to sRGB.
    try {
      if (!probeCtx) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 1;
        probeCtx = cv.getContext('2d', { willReadFrequently: true });
      }
      if (probeCtx) {
        probeCtx.clearRect(0, 0, 1, 1);
        probeCtx.fillStyle = '#000';
        probeCtx.fillStyle = s;
        probeCtx.fillRect(0, 0, 1, 1);
        const d = probeCtx.getImageData(0, 0, 1, 1).data;
        c = { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: d[3] / 255 };
      }
    } catch {
      c = null;
    }
  }
  if (c && c.a <= 0) c = null;
  colorCache.set(s, c);
  return c;
}

/** Short CSS-like path for diagnostics: `table.items > tbody > tr:nth-child(12)`. */
export function describe(el: Element | undefined | null, root?: Element | null): string | undefined {
  if (!el) return undefined;
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && depth < 6) {
    let s = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift(`${s}#${cur.id}`);
      break;
    }
    const cls = Array.from(cur.classList).filter((c) => !c.startsWith('zp-')).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    const parent: Element | null = cur.parentElement;
    if (parent && !cls.length) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      if (same.length > 1) s += `:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`;
    }
    parts.unshift(s);
    if (cur === root) break;
    cur = parent;
    depth++;
  }
  return parts.join(' > ');
}

/** Collects warnings, folding duplicates (same code + element) into a count. */
export class Warnings {
  private map = new Map<string, ExportWarning>();
  constructor(private root?: Element | null) {}
  add(code: string, severity: WarningSeverity, message: string, el?: Element | null, remedy?: string): void {
    const desc = describe(el, this.root);
    const key = `${code}|${desc ?? ''}|${message}`;
    const prev = this.map.get(key);
    if (prev) {
      prev.count++;
      return;
    }
    // Fold many identical codes (e.g. 200 rows each with a shadow) into one per code past a limit.
    let sameCode = 0;
    for (const w of this.map.values()) if (w.code === code) sameCode++;
    if (sameCode >= 20) {
      const k2 = `${code}|*`;
      const agg = this.map.get(k2);
      if (agg) agg.count++;
      else this.map.set(k2, { code, severity, message: `${message} (further occurrences folded)`, element: desc, remedy, count: 1 });
      return;
    }
    this.map.set(key, { code, severity, message, element: desc, remedy, count: 1 });
  }
  list(): ExportWarning[] {
    return [...this.map.values()];
  }
  hasFidelityLoss(): boolean {
    for (const w of this.map.values()) if (w.severity !== 'info') return true;
    return false;
  }
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ZedPdfError('aborted', 'Export was cancelled', []);
}

export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

export function toBytes(x: ArrayBuffer | Uint8Array): Uint8Array {
  return x instanceof Uint8Array ? x : new Uint8Array(x);
}

export async function blobToBytes(b: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (b instanceof Blob) return new Uint8Array(await b.arrayBuffer());
  return toBytes(b);
}
