// Minimal PDF 1.4 writer for invoices: A4 pages, the standard Helvetica / Helvetica-Bold fonts
// (no embedding, so documents are a few KB and cost well under a millisecond of CPU), filled
// rectangles, lines and text. Text is encoded as WinAnsi; characters outside it (for example
// CJK) are written as "?". Kept dependency-free on purpose: a PDF library would add hundreds of
// KB to every Worker cold start on the Free plan.

export type Rgb = readonly [number, number, number];

// Advance widths (1/1000 em) for ASCII 32..126, from the Adobe Helvetica AFM files.
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Unicode -> WinAnsi for the few code points that differ from Latin-1.
const WIN_ANSI: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b,
  0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99,
  0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f, 0x2212: 0x2d,
};

/** Unicode string -> WinAnsi byte codes ("?" for anything unrepresentable). */
export function winAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.replace(/[\r\n\t]+/g, ' ')) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) out.push(cp);
    else out.push(WIN_ANSI[cp] ?? 0x3f);
  }
  return out;
}

export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let w = 0;
  for (const b of winAnsi(text)) w += b >= 32 && b <= 126 ? table[b - 32]! : 556;
  return (w * size) / 1000;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const color = (c: Rgb) => c.map((x) => num(x)).join(' ');
const pdfString = (text: string) =>
  '(' + winAnsi(text).map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 0x80 ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, '0')}`)).join('') + ')';

export class PdfDocument {
  static readonly A4: readonly [number, number] = [595.28, 841.89];
  private readonly pages: string[][] = [];
  private title = '';
  private author = '';

  constructor() {
    this.addPage();
  }

  addPage() {
    this.pages.push([]);
  }

  private get ops() {
    return this.pages[this.pages.length - 1]!;
  }

  setInfo(title: string, author: string) {
    this.title = title;
    this.author = author;
  }

  text(text: string, x: number, y: number, opts: { size?: number; bold?: boolean; color?: Rgb } = {}) {
    this.ops.push(`BT /${opts.bold ? 'F2' : 'F1'} ${num(opts.size ?? 11)} Tf ${color(opts.color ?? [0, 0, 0])} rg ${num(x)} ${num(y)} Td ${pdfString(text)} Tj ET`);
  }

  /** Right-aligned text ending at x. */
  textRight(text: string, xRight: number, y: number, opts: { size?: number; bold?: boolean; color?: Rgb } = {}) {
    this.text(text, xRight - textWidth(text, opts.size ?? 11, opts.bold), y, opts);
  }

  rect(x: number, y: number, w: number, h: number, fill: Rgb) {
    this.ops.push(`${color(fill)} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`);
  }

  line(x1: number, y1: number, x2: number, y2: number, stroke: Rgb, width = 0.7) {
    this.ops.push(`${color(stroke)} RG ${num(width)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
  }

  /** Word-wrap to a width; returns the lines. */
  static wrap(text: string, size: number, maxWidth: number, bold = false): string[] {
    const out: string[] = [];
    let line = '';
    for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, size, bold) > maxWidth) {
        out.push(line);
        line = word;
      } else line = next;
    }
    if (line) out.push(line);
    return out;
  }

  save(): Uint8Array<ArrayBuffer> {
    const objects: string[] = [];
    const add = (body: string) => objects.push(body); // returns the new object number
    const [w, h] = PdfDocument.A4;
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(''); // pages placeholder (object 2)
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids: number[] = [];
    for (const ops of this.pages) {
      const content = ops.join('\n');
      const contentNo = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNo} 0 R >>`));
    }
    objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const infoNo = add(`<< /Title ${pdfString(this.title)} /Author ${pdfString(this.author)} /Producer (RePassCloud Licensing) >>`);
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoNo} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
    return bytes;
  }
}
