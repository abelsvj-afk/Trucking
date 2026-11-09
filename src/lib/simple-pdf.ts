// A small dependency-free PDF writer (docs/design/expense-buckets-documents.md
// section 3): enough of PDF 1.4 to lay out a clean text document - a
// title, headed sections and wrapped lines - across as many pages as
// the content needs. It exists so the app can generate a document
// that "looks right" (a real PDF, openable everywhere, previewable by
// the same Documents pipeline that serves uploads) without adding a
// dependency or an external service.
//
// Text is laid out in Helvetica with conservative metrics (0.5 x font
// size average glyph width) - wrapping is approximate by design, and
// the margins are wide enough that approximation never clips.

export interface PdfTextBlock {
  text: string;
  /** Point size; default 11. The document title uses 17, headings 13. */
  size?: number;
  /** Extra space above the block, in points. */
  spaceBefore?: number;
  bold?: boolean;
}

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const TOP = PAGE_HEIGHT - MARGIN;
const BOTTOM = MARGIN;

/** Escapes a string for a PDF literal string and strips non-WinAnsi bytes. */
export function escapePdfText(text: string): string {
  return text
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Word-wraps one line of text to the content width at the given point size. */
export function wrapLine(text: string, size: number): string[] {
  const maxChars = Math.max(10, Math.floor(CONTENT_WIDTH / (size * 0.52)));
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxChars) {
      if (current) lines.push(current);
      for (let i = 0; i < word.length; i += maxChars) lines.push(word.slice(i, i + maxChars));
      current = "";
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

interface LaidLine {
  text: string;
  size: number;
  bold: boolean;
  y: number;
}

/** Lays blocks out into pages of positioned lines. Pure; exported for tests. */
export function layoutBlocks(blocks: PdfTextBlock[]): LaidLine[][] {
  const pages: LaidLine[][] = [];
  let page: LaidLine[] = [];
  let y = TOP;
  const newPage = () => {
    pages.push(page);
    page = [];
    y = TOP;
  };
  for (const block of blocks) {
    const size = block.size ?? 11;
    const lineHeight = size * 1.45;
    y -= block.spaceBefore ?? 0;
    for (const line of wrapLine(block.text, size)) {
      if (y - lineHeight < BOTTOM) newPage();
      y -= lineHeight;
      page.push({ text: line, size, bold: block.bold ?? false, y });
    }
  }
  pages.push(page);
  return pages;
}

/** Renders text blocks to a complete PDF document (bytes). */
export function renderPdf(blocks: PdfTextBlock[]): Uint8Array {
  const pages = layoutBlocks(blocks);
  const objects: string[] = [];

  // 1: catalog, 2: pages, 3/4: fonts; page objects start at 5.
  const pageObjectIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`;

  pages.forEach((lines, i) => {
    const pageId = pageObjectIds[i]!;
    const contentId = pageId + 1;
    const stream = lines
      .map(
        (l) =>
          `BT /${l.bold ? "F2" : "F1"} ${l.size} Tf ${MARGIN} ${Math.round(l.y)} Td (${escapePdfText(l.text)}) Tj ET`,
      )
      .join("\n");
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
