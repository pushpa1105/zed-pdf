/**
 * Minimal, binary-safe PDF 1.7 writer (ISO 32000-1 §7.5 file structure).
 *
 * - Objects are stored as byte arrays; offsets in the cross-reference table are computed from the
 *   actual bytes written, never from string lengths.
 * - Streams may be Flate-compressed with the platform CompressionStream ('deflate' = zlib, which is
 *   exactly what the PDF FlateDecode filter expects).
 */

const enc = new TextEncoder();

export function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Format a number for PDF content: fixed precision, no exponent, trailing zeros removed. */
export function num(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  if (Object.is(r, -0) || r === 0) return '0';
  let s = r.toFixed(digits);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** PDF name object with #xx escaping for delimiters and non-regular chars. */
export function pdfName(s: string): string {
  let out = '/';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 0x21 || c > 0x7e || '#()<>[]{}/%'.includes(ch)) out += '#' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out;
}

/** Text string for Info entries: ASCII literal when possible, else UTF-16BE hex with BOM. */
export function pdfTextString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return '(' + s.replace(/[\\()]/g, (m) => '\\' + m) + ')';
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return '<' + hex + '>';
}

export function pdfDate(d = new Date()): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `(D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z)`;
}

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface Ref {
  id: number;
  toString(): string;
}

function makeRef(id: number): Ref {
  return { id, toString: () => `${id} 0 R` };
}

export class PdfWriter {
  private objects: (Uint8Array | null)[] = [null]; // index 0 = free head
  /** Compress streams larger than this many bytes. */
  compressThreshold = 64;

  alloc(): Ref {
    this.objects.push(null);
    return makeRef(this.objects.length - 1);
  }

  /** Set a non-stream object body (dictionary/array/etc. as PDF source text). */
  set(ref: Ref, body: string): Ref {
    this.objects[ref.id] = enc.encode(body);
    return ref;
  }

  add(body: string): Ref {
    return this.set(this.alloc(), body);
  }

  /**
   * Set a stream object. `dict` is the dictionary content WITHOUT << >> and without /Length
   * (and without /Filter when compress is requested).
   */
  async setStream(ref: Ref, dict: string, data: Uint8Array, compress = true): Promise<Ref> {
    let payload = data;
    let filter = '';
    if (compress && data.length >= this.compressThreshold) {
      payload = await deflate(data);
      filter = ' /Filter /FlateDecode';
    }
    const head = enc.encode(`<<${dict ? ' ' + dict : ''}${filter} /Length ${payload.length} >>\nstream\n`);
    const tail = enc.encode('\nendstream');
    const out = new Uint8Array(head.length + payload.length + tail.length);
    out.set(head, 0);
    out.set(payload, head.length);
    out.set(tail, head.length + payload.length);
    this.objects[ref.id] = out;
    return ref;
  }

  async addStream(dict: string, data: Uint8Array, compress = true): Promise<Ref> {
    return this.setStream(this.alloc(), dict, data, compress);
  }

  /** Serialize the document. Every allocated object must have been set. */
  finish(root: Ref, info?: Ref): Uint8Array {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    const push = (b: Uint8Array) => {
      chunks.push(b);
      offset += b.length;
    };
    // Header + binary comment line (bytes > 127) so transfer tools treat the file as binary.
    push(latin1('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'));
    const offsets: number[] = new Array(this.objects.length).fill(0);
    for (let id = 1; id < this.objects.length; id++) {
      const body = this.objects[id];
      if (!body) throw new Error(`zedpdf: PDF object ${id} was allocated but never written`);
      offsets[id] = offset;
      push(enc.encode(`${id} 0 obj\n`));
      push(body);
      push(enc.encode('\nendobj\n'));
    }
    const xrefOffset = offset;
    const n = this.objects.length;
    // Each entry is exactly 20 bytes: 10-digit offset, space, 5-digit gen, space, type, CR LF.
    let xref = `xref\n0 ${n}\n0000000000 65535 f\r\n`;
    for (let id = 1; id < n; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n\r\n`;
    const idHex = randomHex(16);
    xref += `trailer\n<< /Size ${n} /Root ${root}${info ? ` /Info ${info}` : ''} /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    push(enc.encode(xref));
    const out = new Uint8Array(offset);
    let p = 0;
    for (const c of chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
