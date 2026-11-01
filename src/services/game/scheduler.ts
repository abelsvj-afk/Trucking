// Gaming System scheduler (docs/design/gaming-system.md §4).
// Same in-process pattern as the research scheduler: an hourly
// tick, all due-ness decided from database state (checkpoint rows,
// the run log), never in-memory timers - Fly restarts this process
// freely. Each tick, for the one company the private Telegram bot
// serves (TELEGRAM_COMPANY_ID - the same single-company scope as
// the bot itself):
//   1. close the just-ended month's checkpoint if it is unclosed
//      (sends the §4.3 digest) and re-game on the checkpoint;
//   2. otherwise, once per day, evaluate the §4.1 data triggers
//      (settlement / fund milestone / research briefing / big
//      maintenance event) and re-game if one fired.
// The game_plan kill switch and the daily re-game cap live in the
// runner/checkpoint services - this file only decides WHEN to ask.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import { getTelegramConfig } from "@/services/telegram/dispatch-bot";
import { createTelegramNotifier } from "@/services/telegram/notify";
import { closeMonthlyCheckpoint } from "./checkpoint";
import { evaluateDataTriggers, runGamePlan } from "./run-game-plan";

const CHECK_IN_MS = 60 * 60 * 1000;

let started = false;

// The unattended-job credential exception, same as the Telegram
// store (docs/design/driver-mvp.md §5): service role, scoped in
// code to the single configured company on every query.
function serviceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey);
}

async function tick(): Promise<void> {
  try {
    const config = getTelegramConfig();
    const companyId = config.companyId;
    const client = companyId ? serviceRoleClient() : null;
    if (!companyId || !client) return; // bot not configured - nothing to game for

    const provider = new OpenAiProvider();
    const notifier = createTelegramNotifier();

    const closed = await closeMonthlyCheckpoint({ client, companyId, notifier });
    if (closed.status === "closed") {
      await runGamePlan({ client, companyId, provider, trigger: "checkpoint" });
      return;
    }

    // Daily data-trigger evaluation (§4.1 debounce): at most one
    // data-triggered re-game per day - check whether one already
    // ran today by looking at the cap counter's neighborhood: if
    // any re-game already succeeded today, still allow the trigger
    // only when none of today's runs was data-triggered.
    const trigger = await evaluateDataTriggers(client, companyId);
    if (!trigger) return;

    const { data, error } = await client
      .from("game_plan_runs")
      .select("id")
      .eq("company_id", companyId)
      .in("trigger", ["settlement", "fund_milestone", "research_briefing", "maintenance_event"])
      .gte("created_at", `${new Date().toISOString().slice(0, 10)}T00:00:00Z`)
      .limit(1);
    if (error) throw new Error(error.message);
    if ((data ?? []).length > 0) return; // already re-gamed on data today

    // The runner enforces the daily cap itself (§2.4).
    await runGamePlan({ client, companyId, provider, trigger });
  } catch (err) {
    // Env not configured / provider unavailable is routine where
    // the capability is off - never a server crash (same call the
    // research scheduler makes).
    console.error("[game] scheduler tick failed", err);
  }
}

/** Idempotent - safe to call more than once. */
export function startGameScheduler(): void {
  if (started) return;
  started = true;

  setInterval(() => void tick(), CHECK_IN_MS);
  void tick();
}
