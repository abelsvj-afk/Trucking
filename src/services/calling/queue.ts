// The outbound-call queue + log (docs/design/outbound-calling.md).
// One shared number, one call at a time per company: rows sit in
// `outbound_calls` (migration 00100) and are claimed atomically by the
// database function, so two machines never dial over each other.

import type { SupabaseClient } from "@supabase/supabase-js";

export type OutboundCallStatus =
  | "queued"
  | "dialing"
  | "in_progress"
  | "completed"
  | "failed"
  | "no_answer"
  | "voicemail";

export interface OutboundCallRow {
  id: string;
  company_id: string;
  driver_id: string | null;
  to_number: string;
  to_name: string;
  purpose: string;
  say: string;
  status: OutboundCallStatus;
  telnyx_call_control_id: string | null;
  telnyx_conversation_id: string | null;
  transcript: string | null;
  outcome: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface EnqueueOutboundCallInput {
  toNumber: string;
  toName: string;
  purpose: string;
  say: string;
  driverId?: string | null;
}

const NOT_LANDED_MESSAGE =
  "Outbound calling isn't switched on yet — the calls table hasn't been added (migration 00100).";

function isMissingTable(error: { message?: string } | null): boolean {
  const message = error?.message ?? "";
  return message.includes("does not exist") || message.includes("Could not find the table");
}

/** Queue a call. Throws a plain-words error when migration 00100 hasn't been applied. */
export async function enqueueOutboundCall(
  client: SupabaseClient,
  companyId: string,
  input: EnqueueOutboundCallInput,
): Promise<OutboundCallRow> {
  const { data, error } = await client
    .from("outbound_calls")
    .insert({
      company_id: companyId,
      driver_id: input.driverId ?? null,
      to_number: input.toNumber,
      to_name: input.toName,
      purpose: input.purpose,
      say: input.say,
      status: "queued",
    })
    .select()
    .single();
  if (error) {
    if (isMissingTable(error)) throw new Error(NOT_LANDED_MESSAGE);
    throw new Error(error.message);
  }
  return data as OutboundCallRow;
}

/**
 * Atomically claim the oldest queued call for the company, but only when
 * no call for that company is already dialing or in progress. Returns
 * null when there is nothing to claim or the line is busy.
 */
export async function claimNextOutboundCall(
  client: SupabaseClient,
  companyId: string,
): Promise<OutboundCallRow | null> {
  const { data, error } = await client.rpc("claim_next_outbound_call", { p_company_id: companyId });
  if (error) {
    if (isMissingTable(error)) throw new Error(NOT_LANDED_MESSAGE);
    throw new Error(error.message);
  }
  return (data as OutboundCallRow | null) ?? null;
}

export type OutboundCallPatch = Partial<
  Pick<
    OutboundCallRow,
    | "status"
    | "telnyx_call_control_id"
    | "telnyx_conversation_id"
    | "transcript"
    | "outcome"
    | "started_at"
    | "ended_at"
    | "duration_seconds"
  >
>;

/** Update one call row, always scoped to its company. */
export async function updateOutboundCall(
  client: SupabaseClient,
  id: string,
  companyId: string,
  patch: OutboundCallPatch,
): Promise<void> {
  const { error } = await client
    .from("outbound_calls")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", companyId);
  if (error) {
    if (isMissingTable(error)) throw new Error(NOT_LANDED_MESSAGE);
    throw new Error(error.message);
  }
}

export async function findOutboundCallByControlId(
  client: SupabaseClient,
  callControlId: string,
): Promise<OutboundCallRow | null> {
  const { data, error } = await client
    .from("outbound_calls")
    .select("*")
    .eq("telnyx_call_control_id", callControlId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) throw new Error(NOT_LANDED_MESSAGE);
    throw new Error(error.message);
  }
  return (data as OutboundCallRow | null) ?? null;
}

export async function listOutboundCalls(
  client: SupabaseClient,
  companyId: string,
  limit = 5,
): Promise<OutboundCallRow[]> {
  const { data, error } = await client
    .from("outbound_calls")
    .select("*")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(20, limit)));
  if (error) {
    if (isMissingTable(error)) throw new Error(NOT_LANDED_MESSAGE);
    throw new Error(error.message);
  }
  return (data ?? []) as OutboundCallRow[];
}

/**
 * Move a call into a final state ONLY if it is not final yet (audit F-006): the
 * status filter makes it atomic, so of two webhook deliveries racing to finish the
 * same call exactly one wins. Returns true when this call did the finishing.
 */
export async function finishOutboundCall(
  client: SupabaseClient,
  id: string,
  companyId: string,
  patch: OutboundCallPatch,
): Promise<boolean> {
  const { data, error } = await client
    .from("outbound_calls")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", companyId)
    .in("status", ["queued", "dialing", "in_progress"])
    .select("id");
  if (error) {
    if (isMissingTable(error)) throw new Error(NOT_LANDED_MESSAGE);
    throw new Error(error.message);
  }
  return ((data ?? []) as unknown[]).length > 0;
}
