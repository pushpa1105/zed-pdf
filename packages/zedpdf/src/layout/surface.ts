/**
 * Export surface: an offscreen, same-origin iframe whose viewport is the printable content width.
 *
 * - The selected element is deep-cloned; the original UI, its scroll position and app state are
 *   never touched.
 * - The element's styling context is rebuilt: all document stylesheets are copied (with url()s made
 *   absolute), the <html>/<body> attributes are copied, and every ancestor is recreated as an
 *   empty wrapper with the same tag and attributes, so descendant selectors, inherited properties,
 *   theme classes and CSS custom properties resolve exactly as in the page. Wrappers are neutralised
 *   for layout (no padding/margins/width constraints).
 * - Direct-download path ('print' media): an iframe is a screen-media context, so `@media print`
 *   rules are re-targeted to `all`, and `@media screen` rules are disabled ("not all"). Feature
 *   queries such as (min-width) evaluate against the iframe viewport = page content width, which
 *   matches how the print layout viewport is sized.
 */
import { Warnings, withTimeout } from '../util.js';

export interface SurfaceOptions {
  width: number;
  height: number;
  /** 'print' re-targets print rules (direct path); 'screen' leaves the screen cascade; 'native' for real printing. */
  media: 'print' | 'screen' | 'native';
  css?: string;
  extraHeadCss?: string;
  title?: string;
  timeout: number;
  expandScrollContainers: boolean;
  furniture?: { header?: string; footer?: string };
  materialize: boolean;
}

export interface Surface {
  iframe: HTMLIFrameElement;
  win: Window;
  doc: Document;
  root: HTMLElement;
  header?: HTMLElement;
  footer?: HTMLElement;
  dispose(): void;
}

const SURFACE_STYLE =
  'position:fixed;left:-100000px;top:0;border:0;margin:0;padding:0;opacity:1;pointer-events:none;z-index:-1;';

export async function createSurface(source: HTMLElement, o: SurfaceOptions, warn: Warnings): Promise<Surface> {
  const hostDoc = source.ownerDocument;
  const iframe = hostDoc.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.title = 'zedpdf export surface';
  iframe.style.cssText = `${SURFACE_STYLE}width:${o.width}px;height:${o.height}px;`;
  (hostDoc.body ?? hostDoc.documentElement).appendChild(iframe);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    iframe.remove();
  };
  try {
    const win = iframe.contentWindow!;
    const doc = iframe.contentDocument!;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title></title></head><body></body></html>`);
    doc.close();
    if (o.title) doc.title = o.title;
    const base = doc.createElement('base');
    base.href = hostDoc.baseURI;
    doc.head.appendChild(base);

    // ---- styles
    const loads: Promise<unknown>[] = [];
    for (const chunk of collectCss(hostDoc, o.media, warn)) {
      if (chunk.kind === 'text') {
        const st = doc.createElement('style');
        st.textContent = chunk.css;
        doc.head.appendChild(st);
      } else {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = chunk.href;
        if (chunk.media) link.media = chunk.media;
        loads.push(new Promise((r) => ((link.onload = r), (link.onerror = r))));
        doc.head.appendChild(link);
      }
    }
    const own = doc.createElement('style');
    own.textContent =
      `html,body{margin:0!important;padding:0!important;width:auto!important;min-width:0!important;max-width:none!important;height:auto!important;min-height:0!important;overflow:visible!important;transform:none!important;zoom:1!important}` +
      `*{content-visibility:visible!important}` +
      `[data-zp-b]::before{content:none!important}[data-zp-a]::after{content:none!important}` +
      `.zp-furniture{position:absolute!important;left:0;right:0;top:0;margin:0}` +
      (o.extraHeadCss ?? '') +
      (o.css ?? '');
    doc.head.appendChild(own);

    // ---- context: html/body attributes + ancestor wrappers
    copyAttrs(hostDoc.documentElement, doc.documentElement);
    doc.documentElement.classList.add('zedpdf-export');
    if (hostDoc.body) copyAttrs(hostDoc.body, doc.body);
    let parent: HTMLElement = doc.body;
    const chain: Element[] = [];
    for (let a = source.parentElement; a && a !== hostDoc.body && a !== hostDoc.documentElement; a = a.parentElement) chain.unshift(a);
    for (const a of chain) {
      const w = doc.createElementNS(a.namespaceURI, a.localName) as HTMLElement;
      copyAttrs(a, w);
      for (const [p, v] of WRAPPER_RESET) w.style.setProperty(p, v, 'important');
      parent.appendChild(w);
      parent = w;
    }

    // ---- clone
    const root = doc.importNode(source, true) as HTMLElement;
    prepareClone(source, root, o, warn);
    parent.appendChild(root);
    const rcs = win.getComputedStyle(root);
    if (rcs.position === 'fixed' || rcs.position === 'absolute') {
      root.style.setProperty('position', 'static', 'important');
      warn.add('root-positioned', 'info', `The exported element is position:${rcs.position}; it was laid out in normal flow`, source);
    }

    // ---- furniture
    let header: HTMLElement | undefined;
    let footer: HTMLElement | undefined;
    if (o.furniture?.header) header = addFurniture(doc, o.furniture.header);
    if (o.furniture?.footer) footer = addFurniture(doc, o.furniture.footer);

    // ---- wait for stylesheets, fonts and images (bounded)
    await withTimeout(Promise.all(loads), o.timeout, []);
    void root.offsetHeight; // trigger layout so used fonts start loading
    await withTimeout(doc.fonts.ready, o.timeout, undefined as unknown as FontFaceSet);
    await waitForImages(root, o.timeout);
    if (o.materialize) {
      materializeGenerated(win, root, warn);
      void root.offsetHeight;
      await withTimeout(doc.fonts.ready, o.timeout, undefined as unknown as FontFaceSet);
    }
    return { iframe, win, doc, root, header, footer, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}

const WRAPPER_RESET: [string, string][] = [
  ['display', 'block'],
  ['position', 'static'],
  ['float', 'none'],
  ['width', 'auto'],
  ['min-width', '0'],
  ['max-width', 'none'],
  ['height', 'auto'],
  ['min-height', '0'],
  ['max-height', 'none'],
  ['margin', '0'],
  ['padding', '0'],
  ['border', '0'],
  ['transform', 'none'],
  ['overflow', 'visible'],
  ['columns', 'auto'],
  ['zoom', '1'],
  ['box-shadow', 'none'],
  ['background', 'none'],
];

function copyAttrs(from: Element, to: Element): void {
  for (const a of Array.from(from.attributes)) {
    try {
      to.setAttribute(a.name, a.value);
    } catch {
      /* invalid attribute name in this namespace */
    }
  }
}

function addFurniture(doc: Document, html: string): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'zp-furniture';
  el.innerHTML = html;
  for (const s of Array.from(el.querySelectorAll('.pageNumber, .totalPages'))) s.textContent = '999';
  doc.body.appendChild(el);
  return el;
}

function prepareClone(src: HTMLElement, clone: HTMLElement, o: SurfaceOptions, warn: Warnings): void {
  for (const s of Array.from(clone.querySelectorAll('script'))) s.remove();
  const srcAll = [src, ...Array.from(src.querySelectorAll('*'))];
  const dstAll = [clone, ...Array.from(clone.querySelectorAll('*'))];
  if (srcAll.length !== dstAll.length) return; // structure changed by script removal etc.; best effort
  const view = src.ownerDocument.defaultView!;
  for (let i = 0; i < srcAll.length; i++) {
    const s = srcAll[i] as HTMLElement;
    const d = dstAll[i] as HTMLElement;
    const tag = s.localName;
    if (tag === 'img') {
      d.setAttribute('loading', 'eager');
      d.removeAttribute('decoding');
    } else if (tag === 'canvas') {
      const sc = s as HTMLCanvasElement;
      const dc = d as HTMLCanvasElement;
      dc.width = sc.width;
      dc.height = sc.height;
      try {
        dc.getContext('2d')?.drawImage(sc, 0, 0);
      } catch {
        warn.add('canvas-unreadable', 'warning', 'A <canvas> could not be copied', s, 'Use a same-origin canvas, or replace it with an <img>');
      }
    } else if (tag === 'input') {
      const si = s as HTMLInputElement;
      const di = d as HTMLInputElement;
      if (si.type === 'checkbox' || si.type === 'radio') di.checked = si.checked;
      else if (si.type !== 'file') {
        di.value = si.value;
        di.setAttribute('value', si.value);
      }
    } else if (tag === 'textarea') {
      (d as HTMLTextAreaElement).value = (s as HTMLTextAreaElement).value;
      d.textContent = (s as HTMLTextAreaElement).value;
    } else if (tag === 'select') {
      (d as HTMLSelectElement).selectedIndex = (s as HTMLSelectElement).selectedIndex;
    } else if (tag === 'details' && (s as HTMLDetailsElement).open) d.setAttribute('open', '');
    if (s.shadowRoot && !d.shadowRoot) {
      warn.add('shadow-dom', 'warning', 'Shadow DOM content is not cloned into the export', s, 'Render the content in light DOM for export');
    }
    if (o.expandScrollContainers && (s.scrollHeight > s.clientHeight + 1 || i === 0)) {
      const cs = view.getComputedStyle(s);
      const scrolls = /auto|scroll|hidden/.test(cs.overflowY) && s.scrollHeight > s.clientHeight + 1;
      if (scrolls) {
        d.style.setProperty('overflow', 'visible', 'important');
        d.style.setProperty('max-height', 'none', 'important');
        d.style.setProperty('height', 'auto', 'important');
        if (i !== 0) {
          warn.add('scroll-container-expanded', 'info', 'A scroll container was expanded to export its full content', s, 'Set expandScrollContainers: false to keep the clipped view');
        }
      }
    }
  }
}

async function waitForImages(root: HTMLElement, timeout: number): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'));
  await Promise.all(
    imgs.map((img) =>
      withTimeout(
        img.complete
          ? Promise.resolve()
          : new Promise<void>((r) => {
              img.addEventListener('load', () => r(), { once: true });
              img.addEventListener('error', () => r(), { once: true });
            }),
        timeout,
        undefined,
      ),
    ),
  );
  await Promise.all(imgs.map((img) => (img.naturalWidth ? withTimeout(img.decode().catch(() => {}), timeout, undefined) : undefined)));
}

// ---------------------------------------------------------------- stylesheet collection

type CssChunk = { kind: 'text'; css: string } | { kind: 'link'; href: string; media?: string };

export function collectCss(doc: Document, media: SurfaceOptions['media'], warn: Warnings): CssChunk[] {
  const out: CssChunk[] = [];
  const sheets: CSSStyleSheet[] = [...Array.from(doc.styleSheets), ...((doc as any).adoptedStyleSheets ?? [])];
  for (const sheet of sheets) {
    if (sheet.disabled) continue;
    const css = serializeSheet(sheet, media);
    if (css != null) {
      out.push({ kind: 'text', css });
      continue;
    }
    if (sheet.href) {
      out.push({ kind: 'link', href: sheet.href, media: rewriteMedia(sheet.media.mediaText, media) || undefined });
      if (media === 'print') {
        warn.add('stylesheet-unreadable', 'info', `Cross-origin stylesheet ${sheet.href} is linked as-is; its @media print rules are not applied on the direct path`, null, 'Serve the stylesheet with CORS (crossorigin attribute) or pass the print CSS via options.css');
      }
    }
  }
  return out;
}

function serializeSheet(sheet: CSSStyleSheet, media: SurfaceOptions['media']): string | null {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return null;
  }
  const base = sheet.href || sheet.ownerNode?.baseURI || document.baseURI;
  let css = '';
  for (const r of Array.from(rules)) css += serializeRule(r, base, media) + '\n';
  const mt = sheet.media?.mediaText;
  if (mt && mt !== 'all') css = `@media ${rewriteMedia(mt, media)} {\n${css}}`;
  return css;
}

function serializeRule(r: CSSRule, base: string, media: SurfaceOptions['media']): string {
  if (r instanceof CSSImportRule) {
    const inner = r.styleSheet ? serializeSheet(r.styleSheet, media) : null;
    if (inner != null) return r.media.mediaText ? `@media ${rewriteMedia(r.media.mediaText, media)} {\n${inner}}` : inner;
    return '';
  }
  if (r instanceof CSSMediaRule) {
    let inner = '';
    for (const c of Array.from(r.cssRules)) inner += serializeRule(c, base, media) + '\n';
    return `@media ${rewriteMedia(r.media.mediaText, media)} {\n${inner}}`;
  }
  if ('cssRules' in r && !(r instanceof CSSStyleRule) && (r as CSSGroupingRule).cssRules) {
    const text = r.cssText;
    const prelude = text.slice(0, text.indexOf('{'));
    let inner = '';
    for (const c of Array.from((r as CSSGroupingRule).cssRules)) inner += serializeRule(c, base, media) + '\n';
    return `${prelude}{\n${inner}}`;
  }
  return absolutizeUrls(r.cssText, base);
}

/** Make url(...) references absolute against the stylesheet URL. */
export function absolutizeUrls(css: string, base: string): string {
  if (!css.includes('url(')) return css;
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
    if (/^(data:|blob:|#|[a-z][a-z0-9+.-]*:\/\/)/i.test(u)) return m;
    try {
      return `url("${new URL(u, base).href}")`;
    } catch {
      return m;
    }
  });
}

/**
 * Evaluate media types as if printing: `print`/`all` → `all`, other types (`screen`, …) → `not all`.
 * Media features are kept and evaluate against the iframe viewport (= page content width).
 */
export function rewriteMedia(mediaText: string, media: SurfaceOptions['media']): string {
  if (media !== 'print' || !mediaText) return mediaText;
  return mediaText
    .split(',')
    .map((q) => {
      const m = /^\s*(only\s+|not\s+)?([a-z-]+)(.*)$/i.exec(q);
      if (!m || m[2].startsWith('(')) return q.trim();
      const type = m[2].toLowerCase();
      if (type === 'and') return q.trim();
      const neg = /^not/i.test(m[1] ?? '');
      const matches = type === 'all' || type === 'print';
      const rest = m[3];
      if (!neg) return matches ? `all${rest}` : 'not all';
      return matches ? `not all${rest}` : 'all';
    })
    .join(', ');
}

// ---------------------------------------------------------------- generated content

/**
 * ::before/::after content and list markers are not in the DOM, so Range geometry cannot see them.
 * They are materialized as real spans carrying the pseudo-element's computed style, and the original
 * pseudo-elements are suppressed. Read phase first, then a single write phase (no layout thrash).
 */
function materializeGenerated(win: Window, root: HTMLElement, warn: Warnings): void {
  const els = [root, ...Array.from(root.querySelectorAll('*'))] as HTMLElement[];
  type Todo = { el: HTMLElement; where: 'before' | 'after' | 'marker'; text: string; css: string };
  const todo: Todo[] = [];
  const olCounters = new Map<Element, number>();
  for (const el of els) {
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
    for (const where of ['before', 'after'] as const) {
      const cs = win.getComputedStyle(el, `::${where}`);
      const content = cs.content;
      if (!content || content === 'none' || content === 'normal') continue;
      if (cs.display === 'none') continue;
      const text = resolveContent(content, el, warn);
      if (text == null) continue;
      todo.push({ el, where, text, css: snapshot(cs) });
    }
    const cs = win.getComputedStyle(el);
    if (cs.display === 'list-item' && cs.listStyleType !== 'none' && cs.listStyleImage === 'none') {
      const parent = el.parentElement;
      let idx = 1;
      if (parent) {
        const reversed = parent.hasAttribute('reversed');
        if (!olCounters.has(parent)) {
          const startAttr = parent.getAttribute('start');
          const count = Array.from(parent.children).filter((c) => c.localName === 'li').length;
          olCounters.set(parent, startAttr != null ? +startAttr : reversed ? count : 1);
        }
        const v = el.getAttribute('value');
        idx = v != null ? +v : olCounters.get(parent)!;
        olCounters.set(parent, idx + (reversed ? -1 : 1));
      }
      const shape = markerShape(cs.listStyleType, cs);
      if (shape) {
        const inside = cs.listStylePosition === 'inside' || el.localName === 'summary';
        todo.push({ el, where: 'marker', text: '', css: inside ? shape.inside : shape.outside });
        continue;
      }
      const text = markerText(cs.listStyleType, idx);
      if (text == null) {
        warn.add('list-marker-unsupported', 'warning', `list-style-type '${cs.listStyleType}' markers are not exported`, el, "Use list-style-type disc/circle/square/decimal/alpha/roman, or a ::before with content");
        continue;
      }
      const inside = cs.listStylePosition === 'inside';
      const css = inside
        ? 'display:inline;'
        : // Out of flow at its static position: cannot change line wrapping (a float could).
          'position:absolute;width:3em;margin-left:-3em;padding-right:0.45em;box-sizing:border-box;text-align:right;white-space:nowrap;text-indent:0;';
      todo.push({ el, where: 'marker', text: inside ? text + ' ' : text, css });
    }
  }
  for (const t of todo) {
    const span = t.el.ownerDocument.createElement('span');
    span.setAttribute('data-zp-generated', t.where);
    span.style.cssText = t.css;
    span.textContent = t.text;
    if (t.where === 'after') t.el.appendChild(span);
    else t.el.insertBefore(span, t.el.firstChild);
    if (t.where === 'before') t.el.setAttribute('data-zp-b', '');
    else if (t.where === 'after') t.el.setAttribute('data-zp-a', '');
    else t.el.style.setProperty('list-style-type', 'none', 'important');
  }
}

function snapshot(cs: CSSStyleDeclaration): string {
  let s = '';
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i];
    if (p === 'content' || p.startsWith('--')) continue;
    s += `${p}:${cs.getPropertyValue(p)};`;
  }
  return s;
}

function resolveContent(content: string, el: Element, warn: Warnings): string | null {
  let out = '';
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(\s*([\w-]+)\s*\)|(counters?\([^)]*\))|([\w-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[1] !== undefined || m[2] !== undefined) out += unescapeCss(m[1] ?? m[2]);
    else if (m[3]) out += el.getAttribute(m[3]) ?? '';
    else if (m[4]) {
      warn.add('generated-counter', 'warning', `Generated content ${m[4]} is not exported`, el, 'Render the number as real text in the DOM');
    }
  }
  return out;
}

function unescapeCss(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, h, c) => (h ? String.fromCodePoint(parseInt(h, 16)) : c));
}

/**
 * Bullets and disclosure triangles are shapes, not text: drawn as CSS boxes (circle/square via
 * border-radius, triangles via borders) so no font needs the glyph. Sizes follow Chromium's markers.
 */
function markerShape(type: string, cs: CSSStyleDeclaration): { inside: string; outside: string } | null {
  const fs = parseFloat(cs.fontSize) || 16;
  const lh = cs.lineHeight === 'normal' ? fs * 1.2 : parseFloat(cs.lineHeight);
  let shape: string;
  let w: number;
  if (type === 'disc' || type === 'circle' || type === 'square') {
    w = fs * 0.36;
    shape =
      `width:${w}px;height:${w}px;box-sizing:border-box;` +
      (type === 'disc' ? 'background:currentColor;border-radius:50%;' : type === 'circle' ? 'border:1px solid currentColor;border-radius:50%;' : 'background:currentColor;');
  } else if (type === 'disclosure-open') {
    w = fs * 0.6;
    shape = `width:0;height:0;border-style:solid;border-color:currentColor transparent transparent transparent;border-width:${fs * 0.5}px ${w / 2}px 0 ${w / 2}px;`;
  } else if (type === 'disclosure-closed') {
    w = fs * 0.5;
    shape = `width:0;height:0;border-style:solid;border-color:transparent transparent transparent currentColor;border-width:${fs * 0.3}px 0 ${fs * 0.3}px ${w}px;`;
  } else return null;
  const top = Math.max(0, (lh - (type.startsWith('disclosure-open') ? fs * 0.5 : type.startsWith('disclosure') ? fs * 0.6 : w)) / 2);
  return {
    inside: `display:inline-block;vertical-align:middle;margin-right:${fs * 0.45}px;${shape}`,
    // Out of flow at its static position: cannot change line wrapping.
    outside: `position:absolute;margin-left:${-(w + fs * 0.6)}px;margin-top:${top}px;${shape}`,
  };
}

function markerText(type: string, n: number): string | null {
  switch (type) {
    case 'disc':
      return '•';
    case 'circle':
      return '◦';
    case 'square':
      return '▪';
    case 'decimal':
      return `${n}.`;
    case 'decimal-leading-zero':
      return `${n < 10 ? '0' : ''}${n}.`;
    case 'lower-alpha':
    case 'lower-latin':
      return `${alpha(n)}.`;
    case 'upper-alpha':
    case 'upper-latin':
      return `${alpha(n).toUpperCase()}.`;
    case 'lower-roman':
      return `${roman(n).toLowerCase()}.`;
    case 'upper-roman':
      return `${roman(n)}.`;
    default:
      return null;
  }
}

function alpha(n: number): string {
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function roman(n: number): string {
  const t: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of t) while (n >= v) {
    s += r;
    n -= v;
  }
  return s;
}
