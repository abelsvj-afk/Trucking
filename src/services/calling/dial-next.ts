// The next-queued-call step, shared by the Telnyx webhook (which
// calls it after a terminal event) and the periodic queue sweep
// (services/calling/scheduler.ts, which covers a missed/lost
// terminal event). One place decides what "advance the queue" means,
// and it never fails silently: a missing piece of calling setup is
// named (mirror of missingCallingSetup, services/calling/config.ts),
// a claim failure is logged, and a dial refusal is logged with the
// dialer's own reason. The row itself already carries the failure
// (dialOutboundCallRow marks it failed with the outcome), so the
// owner can see it in the calls list.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCallingConfig, missingCallingSetup } from "./config";
import { dialOutboundCallRow } from "./dialer";
import { claimNextOutboundCall } from "./queue";

export async function dialNextQueued(client: SupabaseClient, companyId: string): Promise<void> {
  const config = getCallingConfig();
  const missing = missingCallingSetup(config);
  if (missing) {
    // A rotated/missing Telnyx secret after a call ends used to leave
    // the queue stuck with zero trace (audit A-m8) - name the piece.
    console.error(`[calling] cannot dial the next queued call - ${missing}`);
    return;
  }
  let claimed;
  try {
    claimed = await claimNextOutboundCall(client, companyId);
  } catch (err) {
    console.error("[calling] claiming the next queued call failed", err);
    return;
  }
  if (!claimed) return;
  const dialed = await dialOutboundCallRow(client, claimed, { config });
  if (!dialed.ok) {
    console.error(`[calling] queued call ${claimed.id} failed to dial - ${dialed.error}`);
  }
}
