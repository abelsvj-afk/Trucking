// Claude UI pass 2 (2026-11-12): more defects seen by opening the real app
// at phone width (390px). Each test names the visible defect.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("UI pass 2026-11-12", () => {
  it("Game Plan controls fill their row and cannot be wider than the card (the target picker ran off-screen)", () => {
    const css = read("src/app/styles/03-components.css");
    expect(css).toContain(".form-row > input, .form-row > select, .form-row > textarea { width: 100%; max-width: 100%; min-width: 0; }");
    expect(css).toContain("select { max-width: 100%; text-overflow: ellipsis; }");
  });

  it("Financial summary keeps the date range out of the figures grid (it squeezed every label into a sliver)", () => {
    const page = read("src/app/(app)/money/summary/page.tsx");
    expect(page).toContain('<p className="summary-range">');
    expect(page).not.toContain("<dt>Range</dt>");
  });

  it("Financial summary writes a loss as -$568.94, not $-568.94", () => {
    const page = read("src/app/(app)/money/summary/page.tsx");
    expect(page).toContain("return cents < 0 ? `-$${amount}` : `$${amount}`;");
  });

  it("Delete is a quiet red button, never the gold main action", () => {
    expect(read("src/components/RecordLifecycle.tsx").match(/className="button-danger-quiet"/g)).toHaveLength(2);
    expect(read("src/app/(app)/money/advances/page.tsx")).toContain('className="button-danger-quiet"');
    expect(read("src/app/(app)/more/memories/page.tsx")).toContain('className="button-danger-quiet"');
    expect(read("src/app/styles/03-components.css")).toContain("button.button-danger-quiet {");
  });

  it("Research headings have space above them", () => {
    expect(read("src/app/(app)/more/research/page.tsx")).toContain('<div className="research-page">');
    expect(read("src/app/styles/03-components.css")).toContain(".research-page h2, .research-page h3 {");
  });
});
