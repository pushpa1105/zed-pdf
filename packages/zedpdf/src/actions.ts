/**
 * Actions: what people actually do with a PDF once it exists.
 *
 *   const doc = pdf('#invoice', { format: 'A4' });
 *   await doc.download('invoice.pdf');   // or .print(), .open(), .preview(iframe), .share(), .file(), .blob()
 *
 *   const result = await exportPdf(el);  // results carry the same actions
 *   result.download();
 *
 *   <button data-zedpdf="download" data-zedpdf-target="#invoice">Download</button>   // declarative
 */
import { exportPdf } from './export.js';
import { printElement } from './print.js';
import { ZedPdfError, type ExportOptions, type PdfFile, type PrintOptions, type ShareOutcome } from './types.js';
import { defaultFilename } from './result.js';

export type Target = HTMLElement | string;
export type PdfOptions = ExportOptions & Pick<PrintOptions, 'applyPageRule'>;

function resolve(target: Target): HTMLElement {
  if (typeof target !== 'string') return target;
  const el = document.querySelector(target);
  if (!el) throw new ZedPdfError('invalid-element', `No element matches "${target}"`);
  return el as HTMLElement;
}

/**
 * A handle on an element with every PDF action. Each action exports a fresh snapshot, so the
 * PDF always reflects the element as it is when the action runs.
 */
export function pdf(target: Target, options: PdfOptions = {}) {
  const merged = (o?: PdfOptions) => ({ ...options, ...o });
  const render = (o?: PdfOptions) => exportPdf(resolve(target), merged(o));
  return {
    /** Export and return the result (Blob, pageCount, warnings and the actions). */
    render,
    async blob(o?: PdfOptions): Promise<Blob> {
      return (await render(o)).blob;
    },
    async file(name?: string, o?: PdfOptions): Promise<File> {
      return (await render(o)).file(name);
    },
    async download(name?: string, o?: PdfOptions): Promise<PdfFile> {
      const r = await render(o);
      r.download(name);
      return r;
    },
    /** Opens a tab immediately (inside the click), then fills it when the PDF is ready. */
    async open(o?: PdfOptions): Promise<PdfFile> {
      const w = window.open('', '_blank');
      if (w) {
        try {
          w.document.title = 'Preparing PDF…';
          w.document.body.style.cssText = 'font:16px system-ui;color:#555;display:grid;place-items:center;height:100vh;margin:0';
          w.document.body.textContent = 'Preparing PDF…';
        } catch {
          /* cross-origin about:blank edge cases */
        }
      }
      try {
        const r = await render(o);
        r.open(w);
        return r;
      } catch (e) {
        w?.close();
        throw e;
      }
    },
    async preview(where: HTMLIFrameElement | HTMLElement | string, o?: PdfOptions): Promise<PdfFile> {
      const r = await render(o);
      r.preview(where);
      return r;
    },
    async share(data?: { title?: string; text?: string; filename?: string }, o?: PdfOptions): Promise<ShareOutcome> {
      return (await render(o)).share(data);
    },
    /** The browser's own print dialog for just this element. */
    print(o?: PdfOptions): Promise<void> {
      const m = merged(o);
      return printElement(resolve(target), {
        format: m.format,
        orientation: m.orientation,
        margin: m.margin,
        css: m.css,
        title: m.title,
        assetTimeout: m.assetTimeout,
        applyPageRule: m.applyPageRule,
        signal: m.signal,
      });
    },
  };
}

export type PdfHandle = ReturnType<typeof pdf>;

// ---------------------------------------------------------------- declarative buttons

const ACTIONS = new Set(['download', 'print', 'open', 'preview', 'share']);

/** Read options from data-zedpdf-* attributes. */
function optionsFromAttrs(el: HTMLElement): PdfOptions {
  const d = el.dataset;
  const o: PdfOptions & Record<string, unknown> = {};
  if (d.zedpdfOptions) Object.assign(o, JSON.parse(d.zedpdfOptions));
  if (d.zedpdfFormat) o.format = d.zedpdfFormat as PdfOptions['format'];
  if (d.zedpdfOrientation) o.orientation = d.zedpdfOrientation as PdfOptions['orientation'];
  if (d.zedpdfMargin) o.margin = d.zedpdfMargin;
  if (d.zedpdfFilename) o.filename = d.zedpdfFilename;
  if (d.zedpdfTitle) o.title = d.zedpdfTitle;
  if (d.zedpdfMedia) o.media = d.zedpdfMedia as PdfOptions['media'];
  if (d.zedpdfCss) o.css = d.zedpdfCss;
  if (d.zedpdfComplexScripts) o.complexScriptFallback = d.zedpdfComplexScripts as PdfOptions['complexScriptFallback'];
  if (d.zedpdfStrict !== undefined) o.strict = d.zedpdfStrict !== 'false';
  return o;
}

/**
 * Make any element a PDF button, with no JavaScript of your own:
 *
 *   <button data-zedpdf="download" data-zedpdf-target="#invoice" data-zedpdf-filename="INV-42">…</button>
 *   <button data-zedpdf="preview"  data-zedpdf-target="#invoice" data-zedpdf-preview="#viewer">…</button>
 *
 * Actions: download | print | open | preview | share. While running, the button gets
 * aria-busy="true" and is disabled; it dispatches bubbling `zedpdf:done` (detail: { action, result })
 * and `zedpdf:error` (detail: { action, error }) events. Returns a function that unbinds.
 */
export function bindActions(root: Document | HTMLElement = document): () => void {
  const onClick = (e: Event) => {
    const btn = (e.target as Element | null)?.closest?.('[data-zedpdf]') as HTMLElement | null;
    if (!btn || !root.contains(btn)) return;
    const action = btn.dataset.zedpdf ?? '';
    if (!ACTIONS.has(action)) return;
    e.preventDefault();
    if (btn.getAttribute('aria-busy') === 'true') return;
    const targetSel = btn.dataset.zedpdfTarget;
    const target = targetSel ? targetSel : (btn.closest('[data-zedpdf-root]') as HTMLElement | null);
    if (!target) {
      btn.dispatchEvent(new CustomEvent('zedpdf:error', { bubbles: true, detail: { action, error: new ZedPdfError('invalid-element', 'Add data-zedpdf-target="#id" to the button') } }));
      return;
    }
    const opts = optionsFromAttrs(btn);
    const handle = pdf(target, opts);
    const wasDisabled = (btn as HTMLButtonElement).disabled;
    btn.setAttribute('aria-busy', 'true');
    if ('disabled' in btn) (btn as HTMLButtonElement).disabled = true;
    let run: Promise<unknown>;
    // open() must start synchronously inside the click to avoid popup blockers.
    if (action === 'open') run = handle.open();
    else if (action === 'print') run = handle.print();
    else if (action === 'preview') run = handle.preview(btn.dataset.zedpdfPreview ?? '[data-zedpdf-viewer]');
    else if (action === 'share') run = handle.share({ title: opts.title });
    else run = handle.download(opts.filename ? defaultFilename(opts) : undefined);
    run.then(
      (result) => btn.dispatchEvent(new CustomEvent('zedpdf:done', { bubbles: true, detail: { action, result } })),
      (error) => {
        btn.dispatchEvent(new CustomEvent('zedpdf:error', { bubbles: true, detail: { action, error } }));
        if (!btn.hasAttribute('data-zedpdf-quiet')) console.error('[zedpdf]', error);
      },
    ).finally(() => {
      btn.removeAttribute('aria-busy');
      if ('disabled' in btn) (btn as HTMLButtonElement).disabled = wasDisabled;
    });
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
