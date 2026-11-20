// Dialing, shared by the `place_call` tool and the Telnyx webhook
// (docs/design/outbound-calling.md). One place knows how a queued row
// becomes a live call: greeting + purpose + voice override + assistant.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCallGreeting, resolveCallVoice } from "@/lib/outbound-calling";
import type { CallingConfig } from "./config";
import { canPlaceOutboundCall } from "./kill-switch";
import { updateOutboundCall, type OutboundCallRow } from "./queue";
import { dialOutboundCall, hangupCall, startAssistant, type FetchImpl } from "./telnyx";

export interface DialerDeps {
  config: CallingConfig;
  fetchImpl?: FetchImpl;
}

/**
 * Dial a claimed row: place the outbound leg, then attach the AI
 * assistant with the greeting, the purpose, and the voice he picked
 * (Settings -> Abel and AI; null keeps the assistant's stored voice).
 * Marks the row in_progress on success, failed on any refusal - and
 * says which step refused, so the failure is never a mystery.
 * The kill switch is read HERE, right before Telnyx (audit F-005): a call
 * queued while calling was on never dials after it is switched off.
 */
export async function dialOutboundCallRow(
  client: SupabaseClient,
  row: OutboundCallRow,
  deps: DialerDeps,
): Promise<{ ok: true; callControlId: string } | { ok: false; error: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const config = deps.config;
  const allowed = await canPlaceOutboundCall(client, row.company_id);
  if (!allowed.ok) {
    await updateOutboundCall(client, row.id, row.company_id, { status: "failed", outcome: `Not dialed: ${allowed.error}` });
    return { ok: false, error: allowed.error };
  }
  if (!config.phoneNumber || !config.assistantId) {
    const error = "Outbound calling isn't set up yet — the shared number or assistant is missing.";
    await updateOutboundCall(client, row.id, row.company_id, { status: "failed", outcome: error });
    return { ok: false, error };
  }
  let callControlId = "";
  try {
    const dialed = await dialOutboundCall(config, fetchImpl, row.to_number, config.phoneNumber);
    callControlId = dialed.callControlId;
    await updateOutboundCall(client, row.id, row.company_id, {
      telnyx_call_control_id: callControlId,
      started_at: new Date().toISOString(),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Telnyx refused the call.";
    await updateOutboundCall(client, row.id, row.company_id, { status: "failed", outcome: error });
    return { ok: false, error };
  }
  try {
    const voice = await readCallVoice(client, row.company_id);
    await startAssistant(config, fetchImpl, callControlId, {
      assistantId: config.assistantId,
      greeting: buildCallGreeting(row.to_name, row.purpose),
      dynamicVariables: {
        to_name: row.to_name,
        purpose: row.purpose,
        say: row.say,
        from_number: config.phoneNumber,
      },
      voice: resolveCallVoice(voice).telnyxVoice,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Telnyx refused the assistant.";
    // The leg is already ringing (audit F-006): hang it up, or the person answers to silence
    // and the shared number stays busy. A failed hangup is said, never hidden.
    let hungUp = true;
    try {
      await hangupCall(config, fetchImpl, callControlId);
    } catch {
      hungUp = false;
    }
    await updateOutboundCall(client, row.id, row.company_id, {
      status: "failed",
      outcome: hungUp ? `${error} (the call was hung up)` : `${error} (the call could not be hung up - Telnyx may still be ringing)`,
    });
    return { ok: false, error };
  }
  await updateOutboundCall(client, row.id, row.company_id, { status: "in_progress" });
  return { ok: true, callControlId };
}

/** The voice he picked, or null for the Telnyx default. Missing column = default (pre-00100). */
export async function readCallVoice(
  client: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("companies")
    .select("call_voice_id")
    .eq("id", companyId)
    .maybeSingle();
  if (error) return null;
  const voice = (data as { call_voice_id?: unknown } | null)?.call_voice_id;
  return typeof voice === "string" && voice ? voice : null;
}
