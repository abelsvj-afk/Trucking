// Loads audit L-11 + owner ruling 2026-11-10: the load DETAIL page's
// draft-confirm checklist listed "Rate" as a required item — the exact
// wording the owner hit on Trip 1874 (the server refused a rate-less
// confirm, and the checklist agreed with it). Confirming now needs
// pickup + delivery dates only; a missing broker rate is an
// informational note, never a ✗ requirement. The checklist renders
// inside the client page component, so this pins the shipped source
// the way the repo's other *-source tests pin theirs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "src/app/(app)/loads/[id]/page.tsx"), "utf8");

describe("load detail confirm checklist (L-11)", () => {
  it("requires the two dates and nothing else", () => {
    expect(page).toContain('{ label: "Pickup date", ok: Boolean(load.pickup_date) }');
    expect(page).toContain('{ label: "Delivery date", ok: Boolean(load.delivery_date) }');
  });

  it("never presents a rate as a checklist requirement", () => {
    expect(page).not.toContain('{ label: "Rate"');
    expect(page).not.toContain("ok: load.rate_cents != null }");
  });

  it("a missing broker rate is an informational note, in the owner's terms", () => {
    expect(page).toContain("No broker rate on file — not needed to confirm.");
  });
});
