import { createSurface, type Surface } from './layout/surface.js';
import { pageModel } from './page.js';
import { checkAbort, Warnings } from './util.js';
import { ZedPdfError, type PrintOptions } from './types.js';

/**
 * Open the browser's native print flow for just this element. The element is cloned into an
 * offscreen iframe with its full styling context; the browser's own print cascade applies
 * (`@media print`, `@page`, break-* properties). Users choose "Save as PDF" in the dialog.
 * Resolves after the dialog closes (or after a bounded fallback where `afterprint` is unreliable).
 */
export async function printElement(element: HTMLElement, options: PrintOptions = {}): Promise<void> {
  if (!element || element.nodeType !== 1 || !element.isConnected) {
    throw new ZedPdfError('invalid-element', 'printElement expects an HTMLElement attached to a document');
  }
  const page = pageModel(options);
  const warn = new Warnings(element);
  const pageRule =
    options.applyPageRule === false ? '' : `@page{size:${page.cssSize};margin:${page.cssMargin}}`;
  let surface: Surface | null = null;
  try {
    checkAbort(options.signal);
    surface = await createSurface(
      element,
      {
        width: page.contentWidth,
        height: page.contentHeight,
        media: 'native',
        css: options.css,
        extraHeadCss: pageRule + '*{-webkit-print-color-adjust:exact;print-color-adjust:exact}',
        title: options.title ?? element.ownerDocument.title,
        timeout: options.assetTimeout ?? 10000,
        expandScrollContainers: true,
        materialize: false,
      },
      warn,
    );
    checkAbort(options.signal);
    const win = surface.win;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      win.addEventListener('afterprint', finish, { once: true });
      options.signal?.addEventListener('abort', finish, { once: true });
      win.focus();
      win.print(); // blocking in Chromium; asynchronous in some engines
      // Engines where print() returns before the dialog closes fire afterprint later; bound the wait.
      const host = element.ownerDocument.defaultView!;
      const onFocus = () => setTimeout(finish, 500);
      host.addEventListener('focus', onFocus, { once: true });
      setTimeout(finish, 120000);
    });
  } finally {
    surface?.dispose();
  }
}
