// current_company_id() moved to schema `private` in 00006. Migrations
// 00101, 00103 and 00106 still called it unqualified, so none of them
// could apply on a real database (found 2026-11-20). Every later
// migration must call private.current_company_id().
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "supabase/migrations");

describe("migrations after 00006", () => {
  it("never call current_company_id() without the private schema", () => {
    const bad = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f > "00006")
      .filter((f) =>
        readFileSync(join(DIR, f), "utf8")
          .split("\n")
          .some((line) => !line.trim().startsWith("--") && /(^|[^.\w])current_company_id\(\)/.test(line)),
      );
    expect(bad).toEqual([]);
  });
});
