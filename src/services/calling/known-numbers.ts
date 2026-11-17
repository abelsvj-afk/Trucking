// Known numbers only (docs/design/outbound-calling.md). Abel may call a
// driver, a broker, or a customer that is already on file for this
// company - never a number typed in from nowhere. The check normalizes
// both sides, because stored numbers come in every shape.

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeUsPhone } from "@/lib/outbound-calling";

export type KnownNumberKind = "driver" | "broker" | "customer";

export interface KnownNumber {
  name: string;
  kind: KnownNumberKind;
  phone: string;
}

async function loadPhones(
  client: SupabaseClient,
  companyId: string,
  table: string,
  nameColumn: string,
  phoneColumn: string,
): Promise<{ name: string; phone: string }[]> {
  const { data, error } = await client
    .from(table)
    .select(`${nameColumn}, ${phoneColumn}`)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .limit(500);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  return rows
    .map((row) => ({
      name: typeof row[nameColumn] === "string" ? (row[nameColumn] as string) : "",
      phone: typeof row[phoneColumn] === "string" ? (row[phoneColumn] as string) : "",
    }))
    .filter((row) => row.name && row.phone);
}

/** The person behind an E.164 number, when the app already knows them. Null otherwise. */
export async function resolveKnownNumber(
  client: SupabaseClient,
  companyId: string,
  e164: string,
): Promise<KnownNumber | null> {
  const wanted = normalizeUsPhone(e164);
  if (!wanted) return null;
  const [drivers, brokers, customers] = await Promise.all([
    loadPhones(client, companyId, "drivers", "name", "phone"),
    loadPhones(client, companyId, "brokers", "name", "contact_phone"),
    loadPhones(client, companyId, "customers", "name", "contact_phone"),
  ]);
  const checks: { rows: { name: string; phone: string }[]; kind: KnownNumberKind }[] = [
    { rows: drivers, kind: "driver" },
    { rows: brokers, kind: "broker" },
    { rows: customers, kind: "customer" },
  ];
  for (const { rows, kind } of checks) {
    for (const row of rows) {
      if (normalizeUsPhone(row.phone) === wanted) {
        return { name: row.name, kind, phone: wanted };
      }
    }
  }
  return null;
}
