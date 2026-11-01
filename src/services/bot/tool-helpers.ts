// Agent omnipresence (docs/design/driver-mvp.md §9). Shared
// plumbing for the bot's tool files (tools.ts, tools-read.ts,
// tools-write.ts): money formatting, the validateArgs factory every
// write tool uses for dump staging, and the company-scoped row
// fetch/insert/patch helpers the CRUD tools run against.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Builds an AgentTool.validateArgs from a Zod schema: parses
 * (stripping unknown keys, applying the schema's own refinements)
 * and reports the first issues in plain text on failure.
 */
export function validateWith(
  schema: z.ZodType,
): NonNullable<AgentTool["validateArgs"]> {
  return (args) => {
    const result = schema.safeParse(args);
    if (result.success) {
      return { ok: true, args: result.data as Record<string, unknown> };
    }
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: issues };
  };
}

/** True when a Supabase error is a missing-column error (a migration this branch codes against has not landed yet - design §9's graceful-absence rule). */
export function isMissingColumnError(error: { message?: string } | null): boolean {
  if (!error?.message) return false;
  return /does not exist|could not find/i.test(error.message) && /column/i.test(error.message);
}

type Row = Record<string, unknown>;

/** Fetches one live (not soft-deleted) row of the owner's company, or throws a plain "not in his records" error. */
export async function fetchLiveRow(
  client: SupabaseClient,
  table: string,
  companyId: string,
  id: string,
  label: string,
): Promise<Row> {
  const { data, error } = await client
    .from(table)
    .select("*")
    .eq("id", id)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No ${label} with id ${id} in his records.`);
  return data as Row;
}

export async function insertRow(
  client: SupabaseClient,
  table: string,
  companyId: string,
  row: Row,
): Promise<string> {
  const { data, error } = await client
    .from(table)
    .insert({ ...row, company_id: companyId })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

export async function patchLiveRow(
  client: SupabaseClient,
  table: string,
  companyId: string,
  id: string,
  patch: Row,
): Promise<void> {
  const { error } = await client
    .from(table)
    .update(patch)
    .eq("id", id)
    .eq("company_id", companyId)
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
}

/** Drops undefined values so a partial patch never nulls a field the owner didn't mention. */
export function definedOnly(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
