// Outbound-call queue sweeper + feed-health check (audit A-M5, A-m3).
//
// Same in-process scheduler pattern as the research, game, and
// consolidation schedulers (src/instrumentation.ts): an interval tick
// whose due-ness comes from database state, never process memory -
// Fly restarts this process freely. The tick also rides the research
// endpoint's hourly invoker (src/app/api/internal/research/run/route.ts),
// the always-on door for work that must not depend on the app
// happening to be awake.
//
// Every tick, for the one company the private Telegram bot serves
// (TELEGRAM_COMPANY_ID - the same single-company scope as the bot
// itself):
//   1. reap stale claimed calls - a `dialing` / `in_progress` row
//      whose terminal Telnyx event never arrived blocks the whole
//      queue (claim_next_outbound_call refuses while one is open),
//      so the reaper fails it with a plain-words outcome and frees
//      the line (services/calling/queue.ts);
//   2. dial the next queued call when the line is idle - this is
//      what moves the queue when a terminal webhook was missed, lost,
//      or never fired (the webhook alone used to be the only mover);
//   3. run the feed-stale tell - a dead Tracker/Telegram feed while
//      the log says Driving used to surface only on his next inbound
//      Telegram message; the tick fires it on a timer instead
//      (services/telegram/live-location.ts, maybeSendFeedStaleTell).
// Never throws - a failed tick logs and returns, like the schedulers
// it sits beside.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTelegramConfig } from "@/services/telegram/dispatch-bot";
import { createTelegramNotifier } from "@/services/telegram/notify";
import { formatClock, timeZoneForPosition } from "@/lib/display-zone";
import { maybeSendFeedStaleTell } from "@/services/telegram/live-location";
import { dialNextQueued } from "./dial-next";
import { reapStaleOutboundClaims } from "./queue";

/** The queue is re-checked this often - a missed terminal event stalls the next call by at most one tick. */
const CHECK_IN_MS = 5 * 60_000;

let started = false;

// The unattended-job credential exception, same as the Telnyx
// webhook and the Telegram store: service role, scoped in code to
// the single configured company on every query.
function serviceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createSupabaseClient(url, key);
}

export interface CallingSweepDeps {
  serviceClient: () => SupabaseClient | null;
  companyId: () => string | null;
  dialNext: (client: SupabaseClient, companyId: string) => Promise<void>;
  reapStale: (client: SupabaseClient, companyId: string, nowMs: number) => Promise<number>;
  sendFeedStaleTell: (opts: {
    client: SupabaseClient;
    companyId: string;
    sendMessage: (text: string) => Promise<unknown>;
    formatTime: (ms: number, lat: number, lng: number) => string;
    nowMs?: number;
  }) => Promise<boolean>;
  nowMs: number;
}

function productionDeps(): CallingSweepDeps {
  return {
    serviceClient: serviceRoleClient,
    companyId: () => getTelegramConfig().companyId,
    dialNext: dialNextQueued,
    reapStale: reapStaleOutboundClaims,
    sendFeedStaleTell: maybeSendFeedStaleTell,
    nowMs: Date.now(),
  };
}

/**
 * One sweep: reap stale claims, dial the next queued call, and fire
 * the feed-stale tell when the position feed is dead. The
 * zero-argument call is the contract; the overrides exist for tests.
 * Never throws - failures log here, like the tick it replaces.
 */
export async function runCallingSweep(overrides: Partial<CallingSweepDeps> = {}): Promise<void> {
  const deps: CallingSweepDeps = { ...productionDeps(), ...overrides };
  try {
    const companyId = deps.companyId();
    const client = companyId ? deps.serviceClient() : null;
    if (!companyId || !client) return; // bot/calling not configured - nothing to sweep for

    const reaped = await deps.reapStale(client, companyId, deps.nowMs);
    if (reaped > 0) {
      console.error(`[calling] sweep reaped ${reaped} stale claimed call(s) for company ${companyId}`);
    }
    await deps.dialNext(client, companyId);

    // Feed-health check (A-m3): the same tick that keeps the call
    // queue moving also fires the dead-feed tell, so it no longer
    // waits for his next inbound Telegram message. Best-effort - a
    // failure here never fails the sweep.
    try {
      const notifier = createTelegramNotifier();
      await deps.sendFeedStaleTell({
        client,
        companyId,
        sendMessage: (text) => notifier.notifyOwner(text),
        formatTime: (t, lat, lng) => formatClock(t, timeZoneForPosition(lat, lng)),
        nowMs: deps.nowMs,
      });
    } catch (err) {
      console.error("[calling] sweep feed-stale tell failed", err);
    }
  } catch (err) {
    console.error("[calling] sweep failed", err);
  }
}

/** Idempotent - safe to call more than once. */
export function startCallingScheduler(): void {
  if (started) return;
  started = true;

  setInterval(() => void runCallingSweep(), CHECK_IN_MS);
  void runCallingSweep();
}
