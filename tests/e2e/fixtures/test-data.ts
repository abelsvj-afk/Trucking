// Shared test-company seeding/cleanup for the e2e suite, following the
// same pattern already established in
// tests/integration/rls-tenant-isolation.test.ts: a service-role admin
// client creates a real, disposable company + user (never the owner's
// real account) directly against the live Supabase project, seeds the
// minimal related records each workflow needs, and global-teardown.ts
// deletes all of it afterward. Written to a gitignored JSON file
// (tests/e2e/.auth/fixture.json) so global-setup.ts (Node, admin API)
// and auth.setup.ts (Playwright test-runner, browser login) can share
// the same seeded ids without duplicating the seed.

import { createClient } from "@supabase/supabase-js";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface TestFixture {
  companyId: string;
  userId: string;
  email: string;
  password: string;
  truckId: string;
  driverId: string;
  brokerId: string;
  customerId: string;
}

const FIXTURE_PATH = path.resolve(import.meta.dirname, "../.auth/fixture.json");

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to seed e2e test data.",
    );
  }
  return createClient(url, serviceRoleKey);
}

export async function seedTestCompany(): Promise<TestFixture> {
  const admin = adminClient();
  const email = `e2e-${Date.now()}@example.com`;
  const password = crypto.randomUUID();

  const { data: company, error: companyError } = await admin
    .from("companies")
    .insert({ name: "E2E Test Co" })
    .select("id")
    .single();
  if (companyError || !company) throw new Error(`Failed to seed test company: ${companyError?.message}`);

  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !user.user) throw new Error(`Failed to seed test user: ${userError?.message}`);

  const { error: profileError } = await admin
    .from("user_profiles")
    .insert({ id: user.user.id, company_id: company.id, role: "owner" });
  if (profileError) throw new Error(`Failed to seed user_profiles: ${profileError.message}`);

  const { data: truck, error: truckError } = await admin
    .from("trucks")
    .insert({ company_id: company.id, unit_number: "E2E Truck 1" })
    .select("id")
    .single();
  if (truckError || !truck) throw new Error(`Failed to seed truck: ${truckError?.message}`);

  const { data: driver, error: driverError } = await admin
    .from("drivers")
    .insert({ company_id: company.id, name: "E2E Test Driver" })
    .select("id")
    .single();
  if (driverError || !driver) throw new Error(`Failed to seed driver: ${driverError?.message}`);

  const { data: broker, error: brokerError } = await admin
    .from("brokers")
    .insert({ company_id: company.id, name: "E2E Test Broker" })
    .select("id")
    .single();
  if (brokerError || !broker) throw new Error(`Failed to seed broker: ${brokerError?.message}`);

  const { data: customer, error: customerError } = await admin
    .from("customers")
    .insert({ company_id: company.id, name: "E2E Test Customer" })
    .select("id")
    .single();
  if (customerError || !customer) throw new Error(`Failed to seed customer: ${customerError?.message}`);

  const fixture: TestFixture = {
    companyId: company.id,
    userId: user.user.id,
    email,
    password,
    truckId: truck.id,
    driverId: driver.id,
    brokerId: broker.id,
    customerId: customer.id,
  };

  await mkdir(path.dirname(FIXTURE_PATH), { recursive: true });
  await writeFile(FIXTURE_PATH, JSON.stringify(fixture, null, 2));
  return fixture;
}

export async function readTestFixture(): Promise<TestFixture> {
  const raw = await readFile(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as TestFixture;
}

export async function destroyTestCompany(fixture: TestFixture): Promise<void> {
  const admin = adminClient();

  // Same child-before-parent order as rls-tenant-isolation.test.ts's
  // cleanup, for the same reason: cascading deletes via FK aren't assumed.
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
    await admin.from(table).delete().eq("company_id", fixture.companyId);
  }
  await admin.from("user_profiles").delete().eq("id", fixture.userId);
  await admin.from("companies").delete().eq("id", fixture.companyId);
  await admin.auth.admin.deleteUser(fixture.userId);
}
