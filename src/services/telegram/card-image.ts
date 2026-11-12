// Image summary cards (owner 2026-11-11): the same card Abel
// already described in words, rendered as a PNG with sharp -
// already a dependency (services/documents/scan-image.ts), so no
// new package. The image NEVER carries information the text
// doesn't also carry: it is sent only as a photo whose caption is
// the full card text, and any render failure returns null so the
// HTML text card goes out instead. Nothing here is a source of
// truth; the text is.

import sharp from "sharp";

/** XML-escape for the SVG text nodes. */
function escapeXml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Renders a summary card (title + label/value rows) as a PNG.
 * Returns null on any failure - the caller falls back to the text
 * card. Pure layout: dark card, gold header rule (his black/gold
 * branding), rows sized to fit, long values wrapped.
 */
export async function renderSummaryCardPng(
  title: string,
  rows: Array<[string, string]>,
): Promise<Buffer | null> {
  try {
    const width = 900;
    const pad = 48;
    const titleSize = 40;
    const labelSize = 30;
    const valueSize = 30;
    const rowGap = 18;
    const lineHeight = 44;

    // Wrap a value to the card width (rough monospace-free estimate:
    // ~0.55em per char at this size).
    const wrap = (text: string, maxChars: number): string[] => {
      const words = String(text).split(/\s+/).filter(Boolean);
      const out: string[] = [];
      let cur = "";
      for (const word of words) {
        const next = cur ? `${cur} ${word}` : word;
        if (next.length > maxChars && cur) {
          out.push(cur);
          cur = word;
        } else {
          cur = next;
        }
      }
      if (cur) out.push(cur);
      return out.length > 0 ? out : [""];
    };

    const renderedRows: Array<{ label: string; valueLines: string[] }> = rows.map(([label, value]) => ({
      label,
      valueLines: wrap(value, 30),
    }));
    const titleLines = wrap(title, 26);
    const headerHeight = 36 + titleLines.length * (titleSize + 6);
    const rowsHeight = renderedRows.reduce(
      (sum, r) => sum + Math.max(1, r.valueLines.length) * lineHeight + rowGap,
      0,
    );
    const height = headerHeight + rowsHeight + pad;

    const textY = (startY: number, i: number) => startY + i * lineHeight;
    let y = 36;
    const titleSvg = titleLines
      .map((line) => {
        const t = `<text x="${pad}" y="${textY(y, 0) + titleSize * 0.8}" font-family="sans-serif" font-size="${titleSize}" font-weight="bold" fill="#f5c518">${escapeXml(line)}</text>`;
        y += titleSize + 6;
        return t;
      })
      .join("");
    y += 14;
    const ruleY = y;
    y += 30;
    const rowsSvg = renderedRows
      .map((r) => {
        const startY = y;
        const labelSvg = `<text x="${pad}" y="${startY + labelSize * 0.8}" font-family="sans-serif" font-size="${labelSize}" font-weight="bold" fill="#9aa0a6">${escapeXml(r.label)}</text>`;
        const valueSvg = r.valueLines
          .map(
            (line, i) =>
              `<text x="${pad + 300}" y="${textY(startY, i) + valueSize * 0.8}" font-family="sans-serif" font-size="${valueSize}" fill="#ffffff">${escapeXml(line)}</text>`,
          )
          .join("");
        y += Math.max(1, r.valueLines.length) * lineHeight + rowGap;
        return labelSvg + valueSvg;
      })
      .join("");

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="100%" height="100%" rx="24" fill="#111214"/>` +
      `<rect x="0" y="0" width="12" height="100%" fill="#f5c518"/>` +
      titleSvg +
      `<rect x="${pad}" y="${ruleY}" width="${width - pad * 2}" height="2" fill="#2a2d31"/>` +
      rowsSvg +
      `</svg>`;

    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    return png;
  } catch (err) {
    console.error("[telegram] card image render failed - sending the text card instead", err instanceof Error ? err.message : err);
    return null;
  }
}
