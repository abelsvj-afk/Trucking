// Task 1.5 (TASKS.md), extended for Stage 5 task 5.1 ("every table
// together, not per-entity as built"). The single most important test in
// the suite, per docs/design/testing.md: proves company A can never read
// or write company B's rows, enforced by Postgres RLS itself
// (supabase/migrations/) - not by application code that could have a
// missed WHERE clause.
//
// Originally tested trucks alone "as a representative table," reasoning
// that every other tenant-scoped table uses the same current_company_id()
// policy so the same pattern would hold. That reasoning turned out to be
// wrong in two real, found-by-code-review cases: industry_briefings
// (00005) was missing its insert policy entirely, and companies (00001)
// had no update policy at all until 00009 - neither would have been
// caught by testing trucks alone. This file now exercises every
// tenant-scoped table individually instead of trusting the pattern.
//
// Requires a real (or local) Supabase project with migrations 00001-00009
// applied - this cannot run until Task 1.2 is done (see PROJECT_STATE.md)
// and SUPABASE_URL / a service-role key are available as env vars. It
// skips itself with a clear message rather than failing confusingly when
// they're absent - verified directly (not just assumed) by running this
// file with those vars deliberately unset: `1 skipped, 42 skipped`, no
// crash. As of this writing it also can't run *from this sandbox
// specifically* even though it self-skips correctly when the vars are
// genuinely absent, because they're NOT absent here - this sandbox's
// .env.local still has the real project credentials from Stage 1's setup,
// so the test genuinely attempts a live connection and fails on the
// network egress block to *.supabase.co (PROJECT_STATE.md's Known
// Issues), not on anything wrong with the test or the skip logic itself.
// The test is correct and will run normally in CI or on the owner's
// machine, where credentials and network access are both actually
// available together.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const canRun = Boolean(url && serviceRoleKey && anonKey);

describe.skipIf(!canRun)("RLS tenant isolation", () => {
  let admin: SupabaseClient;
  let companyA: string;
  let companyB: string;
  let truckA: string;
  let truckB: string;
  let userAClient: SupabaseClient;
  const userAEmail = `rls-test-a-${Date.now()}@example.com`;
  const userBEmail = `rls-test-b-${Date.now()}@example.com`;
  const password = crypto.randomUUID();

  const seededIds: Record<string, [string, string]> = {};

  beforeAll(async () => {
    // Redundant with describe.skipIf(!canRun) above (verified directly
    // that skipIf alone correctly skips this entire suite, hooks
    // included, when the vars are genuinely absent - see the file header)
    // - kept anyway as cheap, harmless insurance against ever calling
    // admin.from(...) with an unconfigured client.
    if (!canRun) return;

    // Admin (service-role) client for test setup only - the same narrow,
    // deliberate use docs/service-specs.md reserves the service-role key
    // for. Nothing in application code uses this client.
    admin = createClient(url!, serviceRoleKey!);

    const { data: compA } = await admin.from("companies").insert({ name: "RLS Test Co A" }).select("id").single();
    const { data: compB } = await admin.from("companies").insert({ name: "RLS Test Co B" }).select("id").single();
    companyA = compA!.id;
    companyB = compB!.id;

    const { data: userA } = await admin.auth.admin.createUser({ email: userAEmail, password, email_confirm: true });
    const { data: userB } = await admin.auth.admin.createUser({ email: userBEmail, password, email_confirm: true });

    await admin.from("user_profiles").insert([
      { id: userA!.user!.id, company_id: companyA, role: "owner" },
      { id: userB!.user!.id, company_id: companyB, role: "owner" },
    ]);

    // Seeded once, reused by fuel_purchases/maintenance_events below (both
    // have a real not-null FK to trucks).
    const { data: trkA } = await admin
      .from("trucks")
      .insert({ company_id: companyA, unit_number: "Truck A1" })
      .select("id")
      .single();
    const { data: trkB } = await admin
      .from("trucks")
      .insert({ company_id: companyB, unit_number: "Truck B1" })
      .select("id")
      .single();
    truckA = trkA!.id;
    truckB = trkB!.id;

    userAClient = createClient(url!, anonKey!);
    await userAClient.auth.signInWithPassword({ email: userAEmail, password });
  });

  afterAll(async () => {
    if (!canRun) return; // see the top-level beforeAll's comment on why this guard exists

    // Cascading deletes via FK aren't assumed - clean up explicitly so a
    // failed run doesn't leave test data behind. Order matters (children
    // before parents) since several tables reference trucks/companies.
    const tables = [
      "expenses",
      "fuel_purchases",
      "maintenance_events",
      "loads",
      "documents",
      "industry_briefings",
      "industry_briefing_runs",
      "ai_capability_settings",
      "drivers",
      "trailers",
      "customers",
      "brokers",
      "trucks",
    ];
    for (const table of tables) {
      await admin.from(table).delete().in("company_id", [companyA, companyB]);
    }
    await admin.from("user_profiles").delete().in("company_id", [companyA, companyB]);
    await admin.from("companies").delete().in("id", [companyA, companyB]);
  });

  // Standard case: a table with a normal tenant-isolation policy
  // (company_id = current_company_id(), for all - see
  // supabase/migrations/) that an authenticated user can both read and
  // insert into directly.
  function testStandardTable(table: string, buildRow: (companyId: string, truckId: string) => Record<string, unknown>) {
    describe(table, () => {
      beforeAll(async () => {
        if (!canRun) return; // see the top-level beforeAll's comment on why this guard exists
        const { data: rowA } = await admin.from(table).insert(buildRow(companyA, truckA)).select("id").single();
        const { data: rowB } = await admin.from(table).insert(buildRow(companyB, truckB)).select("id").single();
        seededIds[table] = [rowA!.id, rowB!.id];
      });

      it("only sees its own company's rows in a list query", async () => {
        const { data } = await userAClient.from(table).select("id");
        const ids = (data ?? []).map((row: { id: string }) => row.id);
        expect(ids).toContain(seededIds[table]![0]);
        expect(ids).not.toContain(seededIds[table]![1]);
      });

      it("gets nothing back for another company's row by id - 404-equivalent, not 403 (docs/api-contracts.md)", async () => {
        const { data, error } = await userAClient
          .from(table)
          .select("*")
          .eq("id", seededIds[table]![1])
          .maybeSingle();

        expect(error).toBeNull();
        expect(data).toBeNull();
      });

      it("cannot insert a row tagged with another company's id", async () => {
        const { error } = await userAClient.from(table).insert(buildRow(companyB, truckB));
        expect(error).not.toBeNull();
      });
    });
  }

  testStandardTable("trailers", (companyId) => ({ company_id: companyId, unit_number: "Trailer 1" }));
  testStandardTable("drivers", (companyId) => ({ company_id: companyId, name: "Driver 1" }));
  testStandardTable("customers", (companyId) => ({ company_id: companyId, name: "Customer 1" }));
  testStandardTable("brokers", (companyId) => ({ company_id: companyId, name: "Broker 1" }));
  testStandardTable("loads", (companyId) => ({ company_id: companyId, origin: "Dallas, TX", destination: "Miami, FL" }));
  testStandardTable("expenses", (companyId) => ({
    company_id: companyId,
    category: "other",
    amount_cents: 1000,
    expense_date: "2026-08-21",
  }));
  testStandardTable("fuel_purchases", (companyId, truckId) => ({
    company_id: companyId,
    truck_id: truckId,
    gallons: 50,
    price_per_gallon_cents: 385,
    total_cost_cents: 19250,
    purchased_at: "2026-08-21T00:00:00Z",
  }));
  testStandardTable("maintenance_events", (companyId, truckId) => ({
    company_id: companyId,
    truck_id: truckId,
    description: "Oil change",
    service_date: "2026-08-21",
  }));
  testStandardTable("documents", (companyId) => ({
    company_id: companyId,
    related_entity_type: "truck",
    related_entity_id: crypto.randomUUID(),
    file_name: "test.pdf",
    storage_path: `${companyId}/test.pdf`,
  }));
  testStandardTable("ai_capability_settings", (companyId) => ({
    company_id: companyId,
    capability: "industry_intelligence",
    enabled: false,
  }));

  // Special case: industry_briefings and industry_briefing_runs are
  // deliberately NOT insertable by a normal authenticated session at all
  // (docs/automation.md - only the scheduled job's own scoped credential
  // writes them). Admin seeds the rows; the isolation assertions still
  // apply, but "cannot insert as this company" is replaced with "cannot
  // insert at all."
  for (const table of ["industry_briefings", "industry_briefing_runs"]) {
    describe(table, () => {
      beforeAll(async () => {
        if (!canRun) return; // see the top-level beforeAll's comment on why this guard exists
        const base =
          table === "industry_briefings"
            ? {
                summary: "s",
                reasoning: "r",
                confidence: "high",
                based_on: ["test"],
                generated_at: new Date().toISOString(),
              }
            : { started_at: new Date().toISOString(), status: "success" };

        const { data: rowA } = await admin.from(table).insert({ ...base, company_id: companyA }).select("id").single();
        const { data: rowB } = await admin.from(table).insert({ ...base, company_id: companyB }).select("id").single();
        seededIds[table] = [rowA!.id, rowB!.id];
      });

      it("only sees its own company's rows in a list query", async () => {
        const { data } = await userAClient.from(table).select("id");
        const ids = (data ?? []).map((row: { id: string }) => row.id);
        expect(ids).toContain(seededIds[table]![0]);
        expect(ids).not.toContain(seededIds[table]![1]);
      });

      it("gets nothing back for another company's row by id", async () => {
        const { data, error } = await userAClient.from(table).select("*").eq("id", seededIds[table]![1]).maybeSingle();
        expect(error).toBeNull();
        expect(data).toBeNull();
      });

      it("cannot insert as a normal authenticated user, even into its own company", async () => {
        const base =
          table === "industry_briefings"
            ? { summary: "s", reasoning: "r", confidence: "high", based_on: ["test"], generated_at: new Date().toISOString() }
            : { started_at: new Date().toISOString(), status: "success" };
        const { error } = await userAClient.from(table).insert({ ...base, company_id: companyA });
        expect(error).not.toBeNull();
      });
    });
  }

  // Special case: companies itself uses id = current_company_id(), not a
  // company_id column, and only ever has one row per company (no insert
  // policy - company creation isn't a client action, per 00001). Tests
  // the update policy specifically, since that's the real gap 00009 fixed.
  describe("companies", () => {
    it("only sees its own company row in a list query", async () => {
      const { data } = await userAClient.from("companies").select("id");
      const ids = (data ?? []).map((row: { id: string }) => row.id);
      expect(ids).toEqual([companyA]);
    });

    it("can update its own company row", async () => {
      const { error } = await userAClient.from("companies").update({ ai_globally_disabled: true }).eq("id", companyA);
      expect(error).toBeNull();
      const { data } = await admin.from("companies").select("ai_globally_disabled").eq("id", companyA).single();
      expect(data?.ai_globally_disabled).toBe(true);
    });

    it("cannot update another company's row - the real gap migration 00009 fixed", async () => {
      const { error, count } = await userAClient
        .from("companies")
        .update({ ai_globally_disabled: true }, { count: "exact" })
        .eq("id", companyB);
      // RLS silently filters rather than erroring - the meaningful
      // assertion is that nothing was actually changed.
      expect(error).toBeNull();
      expect(count).toBe(0);
      const { data } = await admin.from("companies").select("ai_globally_disabled").eq("id", companyB).single();
      expect(data?.ai_globally_disabled).toBe(false);
    });
  });

  describe("trucks", () => {
    beforeAll(() => {
      seededIds.trucks = [truckA, truckB];
    });

    it("only sees its own company's trucks in a list query", async () => {
      const { data } = await userAClient.from("trucks").select("unit_number");
      expect(data).toHaveLength(1);
      expect(data?.[0]?.unit_number).toBe("Truck A1");
    });

    it("gets nothing back for another company's row by id - not a 403, indistinguishable from missing (docs/api-contracts.md)", async () => {
      const { data, error } = await userAClient.from("trucks").select("*").eq("id", truckB).maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("cannot insert a row into another company", async () => {
      const { error } = await userAClient.from("trucks").insert({ company_id: companyB, unit_number: "Should never exist" });
      expect(error).not.toBeNull();
    });
  });
});
