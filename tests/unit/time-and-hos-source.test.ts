// Reliability Unit B source-level acceptance (B.2.2/B.2.3/B.4.3/
// B.4.6): properties of the shipped source that behavior tests can't
// see - the UTC-slice initializer is gone from EVERY form (the B.2.2
// audit rule, not just the one form F-011 was filed against), the
// touched surfaces render record timestamps through the shared
// formatters rather than ad-hoc locale calls, and the F-014 non-ELD
// boundary copy survives the Unit B rewiring at full strength.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function appSourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

describe("B.2.2 audit rule: no UTC-slice datetime-local initializers remain", () => {
  it("no file under src/app uses toISOString().slice(0, 16) as a value", () => {
    const offenders = appSourceFiles(join(ROOT, "src/app")).filter((file) =>
      readFileSync(file, "utf8").includes("toISOString().slice(0, 16)"),
    );
    expect(offenders).toEqual([]);
  });

  it("all audited forms use the shared local helper", () => {
    // fleet/hos/[id] is no longer a form (UI/UX spec 2026-11-10 §2.2:
    // its edit form retired into a redirect to the day view's one
    // editor; the route keeps only the deleted-entry restore UI), so
    // it leaves this list - the no-UTC-slice audit above still covers
    // every file under src/app, including it.
    for (const rel of [
      "src/app/(app)/fleet/hos/new/page.tsx",
      "src/app/(app)/fleet/pretrip-inspections/new/page.tsx",
      "src/app/(app)/fleet/pretrip-inspections/[id]/page.tsx",
    ]) {
      expect(read(rel), rel).toContain("localDateTimeInputValue");
    }
  });
});

describe("B.2.3: touched surfaces render record timestamps via the shared formatters", () => {
  const RAW_LOCALE_ON_DATE = /new Date\([^)]*\)\.toLocale(?:DateString|String|TimeString)\(/;
  for (const rel of [
    "src/app/(app)/fleet/hos/page.tsx",
    "src/app/(app)/fleet/hos/[id]/page.tsx",
    "src/app/(app)/fleet/pretrip-inspections/page.tsx",
    "src/app/(app)/fleet/pretrip-inspections/[id]/page.tsx",
    "src/app/(app)/money/fuel-purchases/page.tsx",
    "src/app/(app)/money/fuel-purchases/[id]/page.tsx",
  ]) {
    it(`${rel} has no raw new Date(...).toLocale*(...) rendering`, () => {
      expect(read(rel)).not.toMatch(RAW_LOCALE_ON_DATE);
    });
  }

  it("the fuel list renders purchase dates through formatDate (B.4.3 surface)", () => {
    expect(read("src/app/(app)/money/fuel-purchases/page.tsx")).toContain(
      "formatDate(purchase.purchased_at)",
    );
  });
});

describe("B1: the financial-summary route resolves and reports the viewer zone", () => {
  it("route + client carry the tz plumbing", () => {
    expect(read("src/app/api/v1/financial-summary/route.ts")).toContain("resolveViewerTimeZone");
    expect(read("src/lib/api-client.ts")).toContain("tz: viewerTimeZone()");
  });
});

describe("B.4.6 / F-014: the non-ELD boundary survives at full strength", () => {
  it("the HOS list keeps the paper-log disclaimer with the legal-record line", () => {
    const page = read("src/app/(app)/fleet/hos/page.tsx");
    expect(page).toContain("Paper-log helper, not an ELD");
    expect(page).toContain("is the legal record");
  });

  it("the HOS form keeps its not-an-ELD labeling", () => {
    expect(read("src/app/(app)/fleet/hos/new/page.tsx")).toContain("not an ELD");
    expect(read("src/app/(app)/fleet/hos/[id]/page.tsx")).toContain("not an ELD");
  });

  it("both HOS engines keep the boundary in their headers", () => {
    expect(read("src/lib/hos.ts")).toContain("NOT AN ELD");
    expect(read("src/lib/hos.ts")).toContain("legal record");
    expect(read("src/lib/hos-cycle.ts")).toContain("NOT AN ELD");
    expect(read("src/lib/hos-cycle.ts")).toContain("legal record");
  });

  it("the HOS summary is wired to the window fetch and states its cycle basis", () => {
    const page = read("src/app/(app)/fleet/hos/page.tsx");
    expect(page).toContain("useHosWindow");
    expect(page).toContain("carrier periods");
    expect(page).toContain("hos.carrierTimeZone");
  });
});
