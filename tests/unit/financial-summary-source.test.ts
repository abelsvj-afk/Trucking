// Reliability Unit C: source-pinned invariants that tests cannot
// execute without a live database - the migrations' exact semantics
// (C.7.6 backfill arithmetic, C.7.7's DB floor, the read functions'
// security posture) and the snapshot mechanism's scope (C.7.3c(b):
// the isolation change must NOT leak into role defaults anywhere).
// Same discipline as Unit B's time-and-hos source tests: the words
// and expressions in these files ARE the contract, so they are
// asserted verbatim.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const fuelMigration = read("supabase/migrations/00043_fuel_adjustment_and_invariant.sql");
const checksMigration = read(
  "supabase/migrations/00044_financial_checks_and_summary_reads.sql",
);
const snapshotService = read("src/services/financial-summary/snapshot.ts");

describe("migration 00043 - fuel invariant + legacy backfill (C.7.6)", () => {
  it("widens gallons to numeric(10,3) and adds the adjustment columns", () => {
    expect(fuelMigration).toContain("alter column gallons type numeric(10, 3)");
    expect(fuelMigration).toContain("add column adjustment_cents integer not null default 0");
    expect(fuelMigration).toContain("add column adjustment_reason text");
  });

  it("backfills the EXACT difference with the legacy reason, preserving original totals", () => {
    // (a) original total untouched by the update's SET list (only
    // adjustment fields are written); (b)+(c) adjustment = total -
    // round(gallons x price), to the cent.
    expect(fuelMigration).toContain(
      "adjustment_cents = total_cost_cents - round(gallons * price_per_gallon_cents)::integer",
    );
    expect(fuelMigration).toContain("adjustment_reason = 'Legacy variance (pre-F-053)'");
    expect(fuelMigration).not.toMatch(/update fuel_purchases[\s\S]*?set[^;]*total_cost_cents\s*=/);
  });

  it("enforces the invariant and the reason rule as CHECKs", () => {
    expect(fuelMigration).toContain(
      "total_cost_cents = round(gallons * price_per_gallon_cents)::integer + adjustment_cents",
    );
    expect(fuelMigration).toContain("fuel_purchases_adjustment_reason_required");
  });
});

describe("migration 00044 - F-026 floor + snapshot read SQL", () => {
  it("adds the four CHECKs NOT VALID, with the validate procedure documented", () => {
    for (const name of [
      "loads_rate_cents_nonnegative",
      "loads_miles_nonnegative",
      "loads_delivery_not_before_pickup",
      "expenses_amount_cents_nonnegative",
    ]) {
      expect(checksMigration).toContain(name);
    }
    expect(checksMigration.match(/not valid/g)?.length).toBeGreaterThanOrEqual(4);
    expect(checksMigration).toContain("validate constraint");
  });

  it("the read functions are SECURITY INVOKER - never security definer (RLS must apply)", () => {
    expect(checksMigration).toContain("financial_summary_snapshot");
    expect(checksMigration).toContain("financial_summary_detail");
    // Code only: the header prose discusses the prohibition, so strip
    // comment lines before asserting no definition uses it.
    const codeOnly = checksMigration
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(codeOnly.toLowerCase()).not.toContain("security definer");
  });

  it("the snapshot SQL expresses the D-01 recognition rule and the shared filters", () => {
    expect(checksMigration).toContain("status = 'completed'");
    expect(checksMigration).toContain("delivery_date is not null");
    expect(checksMigration).toContain("status in ('draft', 'confirmed')");
    expect(checksMigration).toContain("purchased_at >= p_from_ts");
    expect(checksMigration).toContain("purchased_at < p_to_ts");
  });
});

describe("C.7.6b(d) - the fuel DETAIL view renders the legacy adjustment (source-pinned)", () => {
  // The repo's [id] pages unwrap params with React use(), which never
  // resolves under this vitest/jsdom setup (verified during the
  // build), so no component test can render this page - the same
  // reason the repo has no component tests for any detail page. The
  // rendering contract is therefore pinned here, on the facts
  // section's own expressions.
  const detailPage = read("src/app/(app)/money/fuel-purchases/[id]/page.tsx");

  it("shows the computed base derived from the purchase's gallons x price", () => {
    expect(detailPage).toContain("Computed base");
    expect(detailPage).toContain(
      "deriveFuelTotal(purchase.gallons, purchase.price_per_gallon_cents)",
    );
  });

  it("renders the adjustment amount WITH its reason from the purchase's fields", () => {
    expect(detailPage).toContain("purchase.adjustment_cents !== 0");
    expect(detailPage).toContain("purchase.adjustment_reason");
    expect(detailPage).toContain("formatMoney(purchase.adjustment_cents)");
  });
});

describe("snapshot mechanism scope (C.7.3c(b))", () => {
  it("the transaction's first statement is the BEGIN with isolation, and role/claims are transaction-local", () => {
    expect(snapshotService).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(snapshotService).toContain("SET LOCAL ROLE authenticated");
    expect(snapshotService).toContain("set_config('request.jwt.claims', $1, true)");
    // Identity comes from the verified AuthContext - never params.
    expect(snapshotService).toContain("auth.userId");
  });

  it("no file in src or migrations alters any role's default isolation", () => {
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) scan(rel);
        else if (/\.(ts|tsx|sql)$/.test(entry.name)) {
          if (read(rel).includes("default_transaction_isolation")) offenders.push(rel);
        }
      }
    };
    scan("src");
    scan("supabase/migrations");
    expect(offenders).toEqual([]);
  });
});
