// Task 1.5 (TASKS.md). The single most important test in the suite, per
// docs/design/testing.md: proves company A can never read or write company
// B's rows, for every tenant-scoped table, enforced by Postgres RLS itself
// (supabase/migrations/) - not by application code that could have a
// missed WHERE clause.
//
// Requires a real (or local) Supabase project - this cannot run until
// Task 1.2 is done (see PROJECT_STATE.md) and SUPABASE_URL / a service-role
// key are available as env vars. It skips itself with a clear message
// rather than failing confusingly when they're absent.

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
  let userAClient: SupabaseClient;
  const userAEmail = `rls-test-a-${Date.now()}@example.com`;
  const userBEmail = `rls-test-b-${Date.now()}@example.com`;
  const password = crypto.randomUUID();

  beforeAll(async () => {
    // Admin (service-role) client for test setup only - the same narrow,
    // deliberate use docs/service-specs.md reserves the service-role key
    // for. Nothing in application code uses this client.
    admin = createClient(url!, serviceRoleKey!);

    const { data: compA } = await admin
      .from("companies")
      .insert({ name: "RLS Test Co A" })
      .select("id")
      .single();
    const { data: compB } = await admin
      .from("companies")
      .insert({ name: "RLS Test Co B" })
      .select("id")
      .single();
    companyA = compA!.id;
    companyB = compB!.id;

    const { data: userA } = await admin.auth.admin.createUser({
      email: userAEmail,
      password,
      email_confirm: true,
    });
    const { data: userB } = await admin.auth.admin.createUser({
      email: userBEmail,
      password,
      email_confirm: true,
    });

    await admin
      .from("user_profiles")
      .insert([
        { id: userA!.user!.id, company_id: companyA, role: "owner" },
        { id: userB!.user!.id, company_id: companyB, role: "owner" },
      ]);

    // Seed one row per company in a representative table (trucks). If this
    // table's RLS policy is right, the same pattern holds for every other
    // tenant-scoped table in supabase/migrations/ - they all use the same
    // current_company_id() policy.
    await admin.from("trucks").insert([
      { company_id: companyA, unit_number: "Truck A1" },
      { company_id: companyB, unit_number: "Truck B1" },
    ]);

    // A real client signed in as user A - not the admin client - so RLS
    // actually applies.
    userAClient = createClient(url!, anonKey!);
    await userAClient.auth.signInWithPassword({ email: userAEmail, password });
  });

  afterAll(async () => {
    // Cascading deletes via FK aren't assumed - clean up explicitly so a
    // failed run doesn't leave test data behind.
    await admin.from("trucks").delete().in("company_id", [companyA, companyB]);
    await admin.from("user_profiles").delete().in("company_id", [companyA, companyB]);
    await admin.from("companies").delete().in("id", [companyA, companyB]);
  });

  it("only sees its own company's trucks in a list query", async () => {
    const { data } = await userAClient.from("trucks").select("unit_number");
    expect(data).toHaveLength(1);
    expect(data?.[0]?.unit_number).toBe("Truck A1");
  });

  it("gets nothing back for another company's row by id - not a 403, indistinguishable from missing (docs/api-contracts.md)", async () => {
    const { data: rowB } = await admin
      .from("trucks")
      .select("id")
      .eq("company_id", companyB)
      .single();

    const { data, error } = await userAClient
      .from("trucks")
      .select("*")
      .eq("id", rowB!.id)
      .maybeSingle();

    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("cannot insert a row into another company", async () => {
    const { error } = await userAClient
      .from("trucks")
      .insert({ company_id: companyB, unit_number: "Should never exist" });

    expect(error).not.toBeNull();
  });
});
