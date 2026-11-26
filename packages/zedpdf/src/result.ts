/** Actions attached to every export result: download, open, preview, share, file, url. */
import { ZedPdfError, type ExportResult, type PdfFile, type PdfFileActions } from './types.js';

/** File name from options: explicit filename, else a slug of the title, else "document.pdf". */
export function defaultFilename(o: { filename?: string; title?: string }): string {
  if (o.filename) return /\.pdf$/i.test(o.filename) ? o.filename : `${o.filename}.pdf`;
  const slug = (o.title ?? '').trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${slug || 'document'}.pdf`;
}

const previewUrls = new WeakMap<HTMLIFrameElement, string>();

/** Attach actions to a plain export result. */
export function withActions(r: ExportResult, filename: string): PdfFile {
  let url: string | null = null;
  const actions: PdfFileActions = {
    filename,
    url() {
      if (!url) url = URL.createObjectURL(r.blob);
      return url;
    },
    file(name = filename) {
      return new File([r.blob], name, { type: 'application/pdf' });
    },
    download(name = filename) {
      const u = URL.createObjectURL(r.blob);
      const a = document.createElement('a');
      a.href = u;
      a.download = name;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 30_000);
    },
    open(win) {
      // A window opened synchronously by the caller (to avoid popup blockers) can be reused.
      const u = URL.createObjectURL(r.blob);
      let w: Window | null = null;
      if (win && !win.closed) {
        win.location.href = u;
        w = win;
      } else w = window.open(u, '_blank');
      if (!w) {
        URL.revokeObjectURL(u);
        actions.download();
        return null;
      }
      setTimeout(() => URL.revokeObjectURL(u), 60_000);
      return w;
    },
    preview(where) {
      const host = typeof where === 'string' ? document.querySelector(where) : where;
      if (!host) throw new ZedPdfError('invalid-element', `No element matches "${String(where)}"`);
      let frame: HTMLIFrameElement;
      if (host instanceof HTMLIFrameElement) frame = host;
      else {
        frame = (host.querySelector(':scope > iframe[data-zedpdf-preview]') as HTMLIFrameElement | null) ?? document.createElement('iframe');
        if (!frame.isConnected) {
          frame.dataset.zedpdfPreview = '';
          frame.title = filename;
          frame.style.cssText = 'width:100%;height:100%;min-height:480px;border:0;display:block';
          host.appendChild(frame);
        }
      }
      // Each preview target owns one object URL; the previous one is released.
      const old = previewUrls.get(frame);
      const u = URL.createObjectURL(r.blob);
      previewUrls.set(frame, u);
      frame.src = u;
      if (old) setTimeout(() => URL.revokeObjectURL(old), 1_000);
      return frame;
    },
    async share(data = {}) {
      const f = actions.file(data.filename ?? filename);
      const payload = { files: [f], title: data.title ?? filename, text: data.text };
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (nav.share && nav.canShare?.(payload)) {
        try {
          await nav.share(payload);
          return 'shared';
        } catch (e) {
          if ((e as Error).name === 'AbortError') return 'cancelled';
        }
      }
      actions.download(f.name);
      return 'downloaded';
    },
    dispose() {
      if (url) URL.revokeObjectURL(url);
      url = null;
    },
  };
  return Object.assign(r, actions) as PdfFile;
}

