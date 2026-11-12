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
    // Since 2026-11-12 the page uses the shared formatter; the sign rule lives there.
    expect(read("src/app/(app)/money/summary/page.tsx")).toContain("formatMoney(summary.measures.periodOperatingResult)");
    expect(read("src/lib/money-format.ts")).toContain("? `-$${amount}` : `$${amount}`");
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

  it("Home duty buttons wrap their words inside the button, two per row on a phone (they were cut mid-word)", () => {
    const css = read("src/app/styles/03-components.css");
    const block = css.slice(css.lastIndexOf(".hud-buttons .hud-status-btn {"));
    expect(block).toContain("white-space: normal");
    expect(css).toContain(".hud-buttons {\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  max-width: none;\n  overflow: visible;");
  });

  it("an EXPIRED hours tile keeps its words inside the tile", () => {
    expect(read("src/app/styles/03-components.css")).toContain(".hud-tone-expired .hud-ring-tone { font-size: 0.6875rem;");
  });
});

describe("UI pass 3 2026-11-12", () => {
  it("Home and Day log ask for documents in a way the API accepts (limit=200 was always refused with 400)", () => {
    for (const page of ["src/app/(app)/page.tsx", "src/app/(app)/fleet/hos/page.tsx"]) {
      expect(read(page)).toContain('"documents", { recent: "100" }');
      expect(read(page)).not.toContain('"documents", { limit: "200" }');
    }
    // The route's own rule: without q or an entity, only recent mode is allowed.
    expect(read("src/app/api/v1/documents/route.ts")).toContain("if (!query && !recent && (!relatedEntityType || !relatedEntityId))");
  });

  it("a link inside a sentence stays inline", () => {
    expect(read("src/app/styles/03-components.css")).toContain("section p a { display: inline; margin-top: 0; }");
  });
  it("Truck Fund shows its week and month as days, not raw ISO strings", () => {
    const page = read("src/app/(app)/money/truck-fund/page.tsx");
    expect(page).not.toContain("{data.periods.week.from} –");
    expect(page).toContain("formatPeriodDay(data.periods.month.to)");
  });
});
