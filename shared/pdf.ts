/**
 * A minimal single-page PDF writer.
 *
 * The policy certificate has to be a real file a reader can open, and a demo
 * app should not pull in a rendering library to produce fifteen lines of text.
 * This emits the smallest valid PDF that renders those lines: one page, one
 * built-in font, one content stream.
 *
 * It is deliberately not general. There is no wrapping, no images, no unicode
 * beyond WinAnsi — anything the certificate does not need is absent, because a
 * half-implemented PDF writer is worse than an obvious one.
 */

const PAGE_WIDTH = 595; // A4 at 72dpi
const PAGE_HEIGHT = 842;
const MARGIN = 64;

export type PdfLine = {
  text: string;
  /** 18 for a title, 11 for body. */
  size?: number;
  bold?: boolean;
  /** Extra space above this line, in points. */
  spaceBefore?: number;
};

/**
 * Escapes the three characters that are structural inside a PDF string, and
 * drops anything outside WinAnsi rather than emitting bytes the built-in font
 * cannot map to a glyph.
 */
function escapeText(text: string): string {
  return text
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

export function buildPdf(title: string, lines: PdfLine[]): Blob {
  let cursor = PAGE_HEIGHT - MARGIN;
  const parts: string[] = ["BT"];

  for (const line of lines) {
    const size = line.size ?? 11;
    cursor -= (line.spaceBefore ?? 0) + size + 6;
    const font = line.bold ? "/F2" : "/F1";
    parts.push(`${font} ${size} Tf`);
    parts.push(`1 0 0 1 ${MARGIN} ${cursor} Tm`);
    parts.push(`(${escapeText(line.text)}) Tj`);
  }
  parts.push("ET");
  const content = parts.join("\n");

  // Objects are assembled first, then their byte offsets are measured for the
  // cross-reference table. Getting those offsets wrong is the one thing that
  // makes a PDF unopenable, so they are counted from the encoded bytes rather
  // than from string length.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Title (${escapeText(title)}) /Producer (Northlane Auto demo) >>`,
  ];

  const encoder = new TextEncoder();
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(encoder.encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = encoder.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return new Blob([encoder.encode(pdf)], { type: "application/pdf" });
}

/** Hands a generated file to the browser and cleans up the object URL. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A CSV row writer that quotes every field, so a comma in text is safe. */
export function buildCsv(rows: string[][]): Blob {
  const csv = rows
    .map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(","))
    .join("\n");
  return new Blob([csv], { type: "text/csv;charset=utf-8" });
}
