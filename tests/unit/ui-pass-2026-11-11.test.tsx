// Claude UI pass 2026-11-11: regressions seen by opening the real app at
// phone width (390px) and fixed. Each test names the visible defect.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AbelDrop from "@/components/AbelDrop";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("UI pass 2026-11-11", () => {
  it("AbelDrop renders nothing on the server (it used to break hydration on every page)", () => {
    expect(renderToString(createElement(AbelDrop))).toBe("");
  });

  it("the root <html> tolerates the pre-paint theme attribute", () => {
    expect(read("src/app/layout.tsx")).toContain('<html lang="en" suppressHydrationWarning>');
  });

  it("no page nests a second <main> inside the app layout's <main> (it pushed the inbox off-screen)", () => {
    for (const page of ["src/app/(app)/more/inbox/page.tsx", "src/app/(app)/more/memories/page.tsx"]) {
      expect(read(page)).not.toMatch(/<main[\s>]/);
    }
  });

  it("a filter track wider than the phone scrolls inside itself", () => {
    const css = read("src/app/styles/02-base.css");
    const block = css.slice(css.indexOf('[role="group"] {'), css.indexOf('[role="group"] button {'));
    expect(block).toContain("max-width: 100%");
    expect(block).toContain("overflow-x: auto");
  });

  it("a load with no rate typed does not read as paying $0.00", () => {
    const detail = read("src/app/(app)/loads/[id]/page.tsx");
    expect(detail).toContain('"Not entered"');
    expect(read("src/app/(app)/loads/page.tsx")).toContain("load.rate_cents != null && load.rate_cents > 0");
  });

  it("money pages show days as a driver reads them, not raw ISO strings or zone names", () => {
    expect(read("src/app/(app)/money/summary/page.tsx")).not.toContain("({summary.timeZone})");
    expect(read("src/app/(app)/money/pay/page.tsx")).not.toContain("{load.delivery_date ?? load.pickup_date} ·");
    expect(read("src/app/(app)/money/paychecks/page.tsx")).not.toContain('{c.deliveryDate ?? "no delivery date"}');
  });

  it("Add load keeps the everyday fields on the page and folds the optional detail away", () => {
    const form = read("src/app/(app)/loads/new/page.tsx");
    expect(form.match(/<details className="form-more">/g)).toHaveLength(2);
    expect(form.indexOf('htmlFor="rate"')).toBeLessThan(form.indexOf('htmlFor="pickup_window_start"'));
    expect(form.indexOf('htmlFor="truck_id"')).toBeLessThan(form.indexOf('<details className="form-more">'));
  });
});
