// Audit rank 8: financial deletions require confirmation. Any money screen that removes a record must go through ConfirmDialog or the
// shared DeleteRecordButton (which asks first) - never a bare one-tap apiClient.remove.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : []; });

describe("money screens never delete on one tap", () => {
  for (const file of walk("src/app/(app)/money")) {
    const src = readFileSync(file, "utf8");
    if (!/apiClient\.remove\(/.test(src)) continue;
    it(`${file} asks before removing`, () => {
      expect(/ConfirmDialog/.test(src)).toBe(true);
    });
  }
  it("the cash-advance delete opens the dialog first", () => {
    const src = readFileSync("src/app/(app)/money/advances/page.tsx", "utf8");
    expect(src).toMatch(/onClick=\{\(\) => setPendingDelete\(advance\)\}/);
    expect(src).not.toMatch(/onClick=\{\(\) => handleDelete\(advance\)\}/);
  });
});
