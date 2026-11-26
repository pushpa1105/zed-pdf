/** Public types for zedpdf. */

export type PaperFormat = 'A4' | 'Letter' | 'A3' | 'A5' | 'Legal';
export type Orientation = 'portrait' | 'landscape';

/** A CSS length: number = CSS px, or a string with unit: '12mm', '0.5in', '36pt', '20px', '1cm'. */
export type Length = number | string;

export interface Margins {
  top: Length;
  right: Length;
  bottom: Length;
  left: Length;
}

export interface PageOptions {
  /** Paper size keyword or explicit size. Default 'A4'. */
  format?: PaperFormat | { width: Length; height: Length };
  orientation?: Orientation;
  /** One length for all sides, or per-side. Default '10mm'. */
  margin?: Length | Partial<Margins>;
}

export interface FontSource {
  /** CSS family name exactly as used in font-family. */
  family: string;
  /** Numeric weight (100-900). Default 400. */
  weight?: number;
  style?: 'normal' | 'italic' | 'oblique';
  /** TTF / OTF / WOFF(1) bytes, or a URL to fetch them from. WOFF2 is not supported yet. */
  src: ArrayBuffer | Uint8Array | Blob | string;
}

export type AssetKind = 'image' | 'font';

/**
 * Resolve an asset URL to its bytes. Return null/undefined to let zedpdf fetch it itself.
 * Use this when your application already holds the bytes, or when assets need auth headers.
 */
export type AssetResolver = (
  url: string,
  kind: AssetKind,
) => Promise<ArrayBuffer | Uint8Array | Blob | null | undefined> | ArrayBuffer | Uint8Array | Blob | null | undefined;

export interface PageFurniture {
  /**
   * HTML for a header/footer repeated on every page. Elements with class `pageNumber` / `totalPages`
   * are filled with the page number and page count (same convention as Chromium's headerTemplate).
   */
  html: string;
}

export interface ExportOptions extends PageOptions {
  /** Extra CSS applied only to the export surface (after the page's own styles). */
  css?: string;
  /**
   * Which media rules apply on the direct-download path. 'print' (default) re-targets `@media print`
   * rules to the export surface and disables `@media screen` rules; 'screen' keeps the screen cascade.
   */
  media?: 'print' | 'screen';
  /** Fonts to embed. Families used by the element but not listed here are discovered from @font-face rules. */
  fonts?: FontSource[];
  /** Supply asset bytes yourself (images, fonts). */
  assetResolver?: AssetResolver;
  /** Max time to wait for each image/font/stylesheet (ms). Default 10000. */
  assetTimeout?: number;
  /** Reject with ZedPdfError when any fidelity warning (severity 'warning') is raised. Default false. */
  strict?: boolean;
  /**
   * Fallback for complex scripts (Devanagari, Arabic, Thai, ...) that need OpenType shaping, which the
   * vector text path does not perform yet. 'none' (default) draws unshaped glyphs and warns;
   * 'raster' draws the browser-shaped words as high-resolution images with an invisible text layer
   * so the text remains selectable and searchable.
   */
  complexScriptFallback?: 'none' | 'raster';
  /** Device scale for rasterized content (SVG, canvas, complex-script fallback). Default 3 (~288 dpi). */
  rasterScale?: number;
  /**
   * Largest effective image resolution. Images whose source is much larger than needed for the size
   * they are drawn at are downsampled (e.g. a 4000x3000 photo shown as a 48px thumbnail). Default 300;
   * false keeps every image at its original resolution.
   */
  maxImageDpi?: number | false;
  /** JPEG quality (0-1) used only when a photo has to be re-encoded after downsampling. Default 0.85. */
  jpegQuality?: number;
  /** Monolithic content taller than a page: 'scale' shrinks images to fit; 'slice' splits across pages. Default 'scale'. */
  oversizedImage?: 'scale' | 'slice';
  /** Repeat <thead> rows on every page a table spans. Default true. */
  repeatTableHeader?: boolean;
  /** Treat h1-h6 as `break-after: avoid`. Default false (only author CSS is honored). */
  keepHeadingsWithNext?: boolean;
  /** Expand scroll containers inside the element so their full content is exported. Default true. */
  expandScrollContainers?: boolean;
  header?: PageFurniture;
  footer?: PageFurniture;
  /** Default file name for download/share actions (".pdf" is added if missing). Defaults to a slug of the title. */
  filename?: string;
  /** PDF document title (Info dictionary). */
  title?: string;
  author?: string;
  subject?: string;
  /** Abort the export. Temporary export surfaces are always removed. */
  signal?: AbortSignal;
  /** Called with coarse progress stages. */
  onProgress?: (stage: ProgressStage, detail?: { page?: number; pages?: number }) => void;
}

export type ProgressStage = 'surface' | 'assets' | 'measure' | 'paginate' | 'render' | 'done';

export type WarningSeverity = 'info' | 'warning' | 'error';

export interface ExportWarning {
  /** Stable machine-readable code, e.g. 'font-substituted', 'asset-unavailable'. */
  code: string;
  severity: WarningSeverity;
  message: string;
  /** Short CSS-like path to the affected element, e.g. 'table.items > tbody > tr:nth-child(12)'. */
  element?: string;
  /** Practical remedy. */
  remedy?: string;
  /** Number of occurrences folded into this warning. */
  count: number;
}

export interface ExportResult {
  blob: Blob;
  pageCount: number;
  warnings: ExportWarning[];
  /** Milliseconds spent in each stage. */
  timings: Record<string, number>;
}

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

export interface PdfFileActions {
  /** Default file name used by download/share/file. */
  filename: string;
  /** Object URL for the PDF (created once; released by dispose()). */
  url(): string;
  /** A File, ready for FormData uploads or the Web Share API. */
  file(name?: string): File;
  /** Save the PDF through the browser's download flow. */
  download(name?: string): void;
  /** Open the PDF in a new tab (falls back to download when popups are blocked). */
  open(win?: Window | null): Window | null;
  /** Show the PDF in an <iframe> (or in a container, which gets an iframe). */
  preview(where: HTMLIFrameElement | HTMLElement | string): HTMLIFrameElement;
  /** Share with the system share sheet where supported; otherwise download. */
  share(data?: { title?: string; text?: string; filename?: string }): Promise<ShareOutcome>;
  /** Release the object URL created by url(). */
  dispose(): void;
}

/** An export result together with its actions. */
export type PdfFile = ExportResult & PdfFileActions;

export interface PrintOptions extends PageOptions {
  /** Extra CSS applied to the print document. */
  css?: string;
  /** Document title shown by the print dialog (and used as the default "Save as PDF" file name). */
  title?: string;
  assetTimeout?: number;
  /**
   * When true (default), emit an `@page { size; margin }` rule from the page options. Set false to let
   * the page's own `@page` rules or the user's dialog choice decide.
   */
  applyPageRule?: boolean;
  signal?: AbortSignal;
}

export class ZedPdfError extends Error {
  readonly code: string;
  readonly warnings: ExportWarning[];
  constructor(code: string, message: string, warnings: ExportWarning[] = []) {
    super(message);
    this.name = 'ZedPdfError';
    this.code = code;
    this.warnings = warnings;
  }
}
