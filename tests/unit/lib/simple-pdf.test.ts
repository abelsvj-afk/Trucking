import { describe, expect, it } from "vitest";
import { escapePdfText, layoutBlocks, renderPdf, wrapLine } from "@/lib/simple-pdf";

describe("simple-pdf", () => {
  it("renders a valid-looking PDF with the document's text", () => {
    const bytes = renderPdf([
      { text: "Pay Deduction Notice", size: 17, bold: true },
      { text: "Amount deducted: $250.00" },
    ]);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("Amount deducted: $250.00");
    expect(text).toContain("/Count 1");
  });

  it("escapes parentheses and backslashes in literal strings", () => {
    expect(escapePdfText("a (b) \\ c")).toBe("a \\(b\\) \\\\ c");
  });

  it("wraps long lines and paginates long documents", () => {
    expect(wrapLine("word ".repeat(60).trim(), 11).length).toBeGreaterThan(1);
    const blocks = Array.from({ length: 120 }, (_, i) => ({ text: `Line ${i + 1}` }));
    expect(layoutBlocks(blocks).length).toBeGreaterThan(1);
    expect(new TextDecoder().decode(renderPdf(blocks))).toContain("/Count 3");
  });
});
