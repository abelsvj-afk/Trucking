// Telnyx webhook (docs/design/outbound-calling.md). Telnyx's servers
// call this - no browser session - so it is public in src/proxy.ts and
// enforces its own checks instead, in order:
//   1. Telnyx public key configured (else disabled, 503 - fail closed)
//   2. Ed25519 signature over `timestamp + raw body` (else 401)
//   3. event_type handled; anything else acknowledged and ignored
// Deliberately NOT behind createApiHandler: that pipeline is built for
// session-authenticated owner requests; this caller is authenticated by
// the webhook signature instead (same pattern as /api/telegram/webhook).
//
// Events handled: call.answered -> in_progress; call.hangup -> ended
// (completed, or failed when the hangup cause isn't normal);
// call.conversation.ended -> completed + conversation id;
// call.conversation_insights.generated -> transcript + outcome.
// After a terminal event the next queued call for that company is
// claimed and dialed, so the queue keeps moving on its own.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCallingConfig } from "@/services/calling/config";
import { claimNextOutboundCall, findOutboundCallByControlId, updateOutboundCall } from "@/services/calling/queue";
import { dialOutboundCallRow } from "@/services/calling/dialer";
import { verifyTelnyxSignature } from "@/services/calling/telnyx";

function serviceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createSupabaseClient(url, key);
}

interface TelnyxEvent {
  data?: {
    event_type?: string;
    payload?: {
      call_control_id?: string;
      call_session_id?: string;
      hangup_cause?: string;
      conversation_id?: string;
      transcript?: string;
      summary?: string;
      result?: string;
    };
  };
}

function eventCallControlId(event: TelnyxEvent): string | null {
  const id = event.data?.payload?.call_control_id;
  return typeof id === "string" && id ? id : null;
}

async function dialNextQueued(client: SupabaseClient, companyId: string): Promise<void> {
  const config = getCallingConfig();
  if (!config.telnyxApiKey || !config.phoneNumber || !config.assistantId) return;
  let claimed;
  try {
    claimed = await claimNextOutboundCall(client, companyId);
  } catch {
    return;
  }
  if (!claimed) return;
  await dialOutboundCallRow(client, claimed, { config });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const config = getCallingConfig();
  if (!config.publicKey) {
    // Fail closed: without the public key no signature can be checked.
    return NextResponse.json({ error: "Telnyx webhook is not configured." }, { status: 503 });
  }
  const rawBody = await req.text();
  const signature = req.headers.get("telnyx-signature-ed25519");
  const timestamp = req.headers.get("telnyx-timestamp");
  if (!verifyTelnyxSignature(config.publicKey, timestamp, rawBody, signature)) {
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }
  let event: TelnyxEvent;
  try {
    event = JSON.parse(rawBody) as TelnyxEvent;
  } catch {
    return NextResponse.json({ error: "Bad JSON." }, { status: 400 });
  }
  const eventType = event.data?.event_type ?? "";
  const callControlId = eventCallControlId(event);
  const client = serviceRoleClient();
  if (!client || !callControlId) return NextResponse.json({ received: true });
  let row;
  try {
    row = await findOutboundCallByControlId(client, callControlId);
  } catch {
    return NextResponse.json({ received: true });
  }
  if (!row) return NextResponse.json({ received: true });
  const payload = event.data?.payload ?? {};
  const now = new Date().toISOString();

  if (eventType === "call.answered") {
    await updateOutboundCall(client, row.id, row.company_id, { status: "in_progress", started_at: now });
    return NextResponse.json({ received: true });
  }

  if (eventType === "call.conversation.ended") {
    await updateOutboundCall(client, row.id, row.company_id, {
      status: "completed",
      telnyx_conversation_id:
        typeof payload.conversation_id === "string" ? payload.conversation_id : row.telnyx_conversation_id,
      ended_at: now,
    });
    await dialNextQueued(client, row.company_id);
    return NextResponse.json({ received: true });
  }

  if (eventType === "call.conversation_insights.generated") {
    const transcript = typeof payload.transcript === "string" ? payload.transcript : null;
    const summary = typeof payload.summary === "string" ? payload.summary : null;
    await updateOutboundCall(client, row.id, row.company_id, {
      transcript: transcript ?? row.transcript,
      outcome: summary ?? row.outcome,
    });
    return NextResponse.json({ received: true });
  }

  if (eventType === "call.hangup") {
    const cause = typeof payload.hangup_cause === "string" ? payload.hangup_cause : "";
    const normal = cause === "" || cause === "normal_clearing" || cause === "NORMAL_CLEARING";
    const duration =
      row.started_at != null
        ? Math.max(0, Math.round((new Date(now).getTime() - new Date(row.started_at).getTime()) / 1000))
        : null;
    await updateOutboundCall(client, row.id, row.company_id, {
      status: normal ? "completed" : "failed",
      outcome: normal ? (row.outcome ?? "Call ended.") : `Call ended: ${cause}`,
      ended_at: now,
      duration_seconds: duration,
    });
    await dialNextQueued(client, row.company_id);
    return NextResponse.json({ received: true });
  }

  return NextResponse.json({ received: true });
}
