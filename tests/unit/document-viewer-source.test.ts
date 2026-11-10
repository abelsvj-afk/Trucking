import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source pins (repo *-source.test.ts pattern): the print stylesheet
// targets ONLY the document, and DocumentPreview is retired.
describe("document viewer source", () => {
  it("print stylesheet exists and targets only the document print area", () => {
    const css = readFileSync("src/app/styles/03-components.css", "utf8");
    expect(css).toContain("@media print");
    expect(css).toContain(".doc-print-area");
    const printBlock = css.slice(css.indexOf("@media print"));
    expect(printBlock).toContain("visibility: hidden");
    expect(printBlock).toContain(".doc-print-area");
  });

  it("DocumentPreview component is gone and nothing imports it", () => {
    expect(() => readFileSync("src/components/DocumentPreview.tsx", "utf8")).toThrow();
    for (const f of [
      "src/components/EntityDocuments.tsx",
      "src/components/LoadDocuments.tsx",
      "src/app/(app)/more/documents/page.tsx",
    ]) {
      expect(readFileSync(f, "utf8")).not.toContain("DocumentPreview");
      expect(readFileSync(f, "utf8")).toContain("/more/documents/");
    }
  });

  it("labels live in the shared lib module", () => {
    const lib = readFileSync("src/lib/document-labels.ts", "utf8");
    expect(lib).toContain("DOC_TYPE_LABELS");
    expect(lib).toContain("SITUATION_LABELS");
    expect(lib).toContain("extractionStatusText");
  });
});
