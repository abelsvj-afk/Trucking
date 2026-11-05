import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Unit D acceptance D.5.6 / ruling D-02: no UI string on a per-load surface calls
// a per-load figure "profit". Comments are ignored; string/JSX text is not.
const FILES = [
  "src/app/(app)/loads/[id]/page.tsx",
  "src/components/LoadEconomicsSection.tsx",
  "src/components/FuelLoadPicker.tsx",
  "src/app/(app)/money/fuel-purchases/new/page.tsx",
  "src/app/(app)/money/fuel-purchases/[id]/page.tsx",
];

describe("per-load surfaces never say 'profit' (D-02)", () => {
  for (const file of FILES) {
    it(file, () => {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      expect(code).not.toMatch(/\bprofit/i);
    });
  }
});
