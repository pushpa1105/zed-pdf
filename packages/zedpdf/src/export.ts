import { createSurface, type Surface } from './layout/surface.js';
import { measureFurniture, walk, type Furniture } from './layout/walk.js';
import { paginate, PaginationError } from './paginate/paginate.js';
import { FontManager } from './font/fonts.js';
import { loadAssets } from './image/images.js';
import { Renderer } from './render/render.js';
import { PdfWriter, pdfDate, pdfTextString, num, type Ref } from './pdf/writer.js';
import { pageModel, PX_TO_PT } from './page.js';
import { checkAbort, Warnings } from './util.js';
import { ZedPdfError, type ExportOptions, type PdfFile } from './types.js';
import { defaultFilename, withActions } from './result.js';

declare const __ZEDPDF_VERSION__: string;
export const VERSION: string = typeof __ZEDPDF_VERSION__ !== 'undefined' ? __ZEDPDF_VERSION__ : 'dev';

/**
 * Export an element to a PDF Blob, entirely in the browser, without a print dialog.
 * Text stays real text (selectable, searchable); boxes are vector; images keep their resolution.
 */
export async function exportPdf(element: HTMLElement, options: ExportOptions = {}): Promise<PdfFile> {
  if (!element || element.nodeType !== 1 || !element.ownerDocument?.defaultView) {
    throw new ZedPdfError('invalid-element', 'exportPdf expects an HTMLElement that is attached to a document');
  }
  if (!element.isConnected) throw new ZedPdfError('invalid-element', 'The element must be attached to the document');
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (k: string) => {
    const n = performance.now();
    timings[k] = Math.round((n - t) * 10) / 10;
    t = n;
  };
  const progress = options.onProgress ?? (() => {});
  const signal = options.signal;
  const warn = new Warnings(element);
  const page = pageModel(options);
  const timeout = options.assetTimeout ?? 10000;
  const walkOpts = {
    complexScriptFallback: options.complexScriptFallback ?? 'none',
    keepHeadingsWithNext: options.keepHeadingsWithNext ?? false,
  } as const;
  let surface: Surface | null = null;
  try {
    checkAbort(signal);
    progress('surface');
    surface = await createSurface(
      element,
      {
        width: page.contentWidth,
        height: page.contentHeight,
        media: options.media ?? 'print',
        css: options.css,
        title: options.title,
        timeout,
        expandScrollContainers: options.expandScrollContainers ?? true,
        furniture: { header: options.header?.html, footer: options.footer?.html },
        materialize: true,
      },
      warn,
    );
    lap('surface');
    checkAbort(signal);

    progress('measure');
    const w = walk(surface.win, surface.root, walkOpts, warn, { header: surface.header, footer: surface.footer });
    if (w.overflowX > 1) {
      warn.add('horizontal-overflow', 'warning', `Content is ${w.overflowX.toFixed(0)}px wider than the printable width and extends into the margin`, null, 'Make the layout fluid (max-width: 100%) or choose landscape / smaller margins');
    }
    lap('measure');
    checkAbort(signal);

    progress('assets');
    const fonts = new FontManager(warn, options.assetResolver, timeout);
    fonts.addSources(options.fonts);
    fonts.discover(surface.doc);
    await fonts.prepare(w.fonts);
    checkAbort(signal);
    const images = await loadAssets(w.assets, surface.doc, { resolver: options.assetResolver, timeout, rasterScale: options.rasterScale ?? 3, maxImageDpi: options.maxImageDpi ?? 300, jpegQuality: options.jpegQuality ?? 0.85, signal }, warn);
    lap('assets');
    checkAbort(signal);

    progress('paginate');
    const headerH = w.header?.height ?? 0;
    const footerH = w.footer?.height ?? 0;
    const usable = page.contentHeight - headerH - footerH;
    if (usable < 50) throw new ZedPdfError('furniture-too-tall', 'Header/footer leave no room for content');
    let pages;
    try {
      pages = paginate(
        w.root,
        { pageHeight: usable, repeatTableHeader: options.repeatTableHeader ?? true, oversizedImage: options.oversizedImage ?? 'scale' },
        (d) => warn.add(d.code, d.severity, d.message, d.el, d.remedy),
      );
    } catch (e) {
      if (e instanceof PaginationError) throw new ZedPdfError('pagination-failed', e.message, warn.list());
      throw e;
    }
    lap('paginate');
    if (options.strict && warn.hasFidelityLoss()) {
      throw new ZedPdfError('fidelity', 'Strict mode: the export would lose fidelity (see warnings)', warn.list());
    }

    // Page furniture with page numbers: re-measure only the small furniture element per page.
    const total = pages.length;
    const perPage = (el: HTMLElement | undefined, base: Furniture | undefined) => {
      if (!el || !base) return null;
      const tokens = el.querySelectorAll('.pageNumber, .totalPages');
      if (!tokens.length) return pages.map(() => base);
      return pages.map((_, i) => {
        for (const s of Array.from(tokens)) s.textContent = String(s.classList.contains('pageNumber') ? i + 1 : total);
        return measureFurniture(surface!.win, surface!.root, el, walkOpts, warn);
      });
    };
    const headers = perPage(surface.header, w.header);
    const footers = perPage(surface.footer, w.footer);
    const lang = surface.doc.documentElement.lang || element.ownerDocument.documentElement.lang || '';
    surface.dispose();
    surface = null;
    checkAbort(signal);

    progress('render');
    const pdf = new PdfWriter();
    const renderer = new Renderer(fonts, images, warn);
    const pagesRef = pdf.alloc();
    const resRef = pdf.alloc();
    const pageRefs: Ref[] = [];
    const W = page.width * PX_TO_PT;
    const H = page.height * PX_TO_PT;
    const contentTop = page.margin.top + headerH;
    const prefix = `q ${PX_TO_PT} 0 0 ${-PX_TO_PT} ${num(page.margin.left * PX_TO_PT, 4)} ${num(H - contentTop * PX_TO_PT, 4)} cm`;
    for (let i = 0; i < pages.length; i++) {
      progress('render', { page: i + 1, pages: total });
      const extra: { items: import('./layout/model.js').Item[]; dy: number }[] = [];
      const hd = headers?.[i];
      const ft = footers?.[i];
      if (hd) extra.push({ items: hd.items, dy: -headerH - hd.top });
      if (ft) extra.push({ items: ft.items, dy: usable - ft.top });
      renderer.links = [];
      const content = renderer.page(pages[i], prefix, extra);
      const cref = await pdf.addStream('', new TextEncoder().encode(content));
      // Clickable links (ISO 32000-1 §12.5.6.5): rects mapped from content-area px to page points.
      const annots = renderer.links.map((l) => {
        const x0 = (page.margin.left + l.x) * PX_TO_PT;
        const x1 = x0 + l.w * PX_TO_PT;
        const y1 = H - (contentTop + l.y) * PX_TO_PT;
        const y0 = y1 - l.h * PX_TO_PT;
        const uri = safeUri(l.href).replace(/[\\()]/g, (m) => '\\' + m);
        return pdf.add(`<< /Type /Annot /Subtype /Link /Rect [${num(x0)} ${num(y0)} ${num(x1)} ${num(y1)}] /Border [0 0 0] /A << /S /URI /URI (${uri}) >> >>`);
      });
      pageRefs.push(pdf.add(`<< /Type /Page /Parent ${pagesRef} /MediaBox [0 0 ${num(W, 4)} ${num(H, 4)}] /Resources ${resRef} /Contents ${cref}${annots.length ? ` /Annots [${annots.join(' ')}]` : ''} >>`));
      if (i % 20 === 19) checkAbort(signal);
    }
    if (fonts.missing.size) {
      const chars = [...fonts.missing].slice(0, 20).join(' ');
      warn.add('missing-glyph', 'warning', `No available font contains these characters; they are drawn as '?' or .notdef: ${chars}`, null, 'Supply a font covering them via options.fonts / @font-face (TTF/OTF/WOFF)');
    }
    if (options.strict && warn.hasFidelityLoss()) {
      throw new ZedPdfError('fidelity', 'Strict mode: the export would lose fidelity (see warnings)', warn.list());
    }

    // Resources shared by all pages: fonts, images, alpha states — each written once.
    const fontRefs = await fonts.write(pdf);
    let xobj = '';
    const written = new Map<object, Ref>(); // the same decoded image object is written once
    for (const idx of renderer.usedImages) {
      const im = images[idx]!;
      let iref = written.get(im);
      if (!iref) {
        let smask = '';
        if (im.smask) {
          const sw = im.smask.width ?? im.width;
          const shh = im.smask.height ?? im.height;
          const sref = await pdf.addStream(`/Type /XObject /Subtype /Image /Width ${sw} /Height ${shh} ${im.smask.dict}`, im.smask.data, !im.smask.encoded);
          smask = ` /SMask ${sref}`;
        }
        iref = await pdf.addStream(`/Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} ${im.dict}${smask}`, im.data, !im.encoded);
        written.set(im, iref);
      }
      xobj += `/${renderer.imageRes(idx)} ${iref} `;
    }
    let fontDict = '';
    for (const [res, ref] of fontRefs) fontDict += `/${res} ${ref} `;
    let gsDict = '';
    for (const [a, n] of renderer.alphas) gsDict += `/${n} << /Type /ExtGState /ca ${a} /CA ${a} >> `;
    pdf.set(resRef, `<< /ProcSet [/PDF /Text /ImageB /ImageC] /Font << ${fontDict}>> /XObject << ${xobj}>> /ExtGState << ${gsDict}>> >>`);
    pdf.set(pagesRef, `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`);
    const catalog = pdf.add(`<< /Type /Catalog /Pages ${pagesRef}${lang ? ` /Lang ${pdfTextString(lang)}` : ''} >>`);
    const info = pdf.add(
      `<< /Producer ${pdfTextString(`zedpdf ${VERSION}`)} /Creator ${pdfTextString('zedpdf')} /CreationDate ${pdfDate()}` +
        (options.title ? ` /Title ${pdfTextString(options.title)}` : '') +
        (options.author ? ` /Author ${pdfTextString(options.author)}` : '') +
        (options.subject ? ` /Subject ${pdfTextString(options.subject)}` : '') +
        ' >>',
    );
    const bytes = pdf.finish(catalog, info);
    lap('render');
    progress('done');
    return withActions(
      { blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }), pageCount: pages.length, warnings: warn.list(), timings },
      defaultFilename(options),
    );
  } catch (e) {
    if (e instanceof ZedPdfError) throw e;
    if ((e as Error)?.name === 'AbortError' || signal?.aborted) throw new ZedPdfError('aborted', 'Export was cancelled', warn.list());
    throw e;
  } finally {
    surface?.dispose();
  }
}

/** Trigger a download of a PDF Blob and revoke the object URL afterwards. */
export function savePdf(blob: Blob, filename = 'document.pdf'): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** 7-bit ASCII URI for a PDF string (malformed escapes are re-encoded rather than thrown). */
function safeUri(href: string): string {
  try {
    return encodeURI(decodeURI(href));
  } catch {
    return encodeURI(href);
  }
}
