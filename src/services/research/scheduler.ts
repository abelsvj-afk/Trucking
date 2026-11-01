// Deep Research Engine scheduler (docs/design/research-engine.md §9).
// Same discipline as the Stage-4 scheduler: an hourly check-in tick,
// with all due-ness decided from database state (watcher state, run
// counts, run history) - never in-memory timers - because Fly restarts
// this process freely. Each tick: poll watchers (signals are the
// archive; polling costs no AI spend) -> run the engine for eligible
// companies (the kill switch + caps live in run-research.ts).

import { getIndustryBriefingPool } from "@/services/db/industry-briefing-pool";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import { createTelegramNotifier } from "@/services/telegram/notify";
import { pollAllWatchers } from "./watchers";
import { runResearchJob } from "./run-research";

const CHECK_IN_MS = 60 * 60 * 1000;

let started = false;

async function tick(): Promise<void> {
  try {
    const pool = getIndustryBriefingPool();
    const freshSignals = await pollAllWatchers(pool);
    const provider = new OpenAiProvider();
    await runResearchJob(pool, provider, createTelegramNotifier(), freshSignals);
  } catch (err) {
    // Pool/provider construction throws synchronously when env isn't
    // configured - routine in environments where the engine is off,
    // not a crash for the whole server (same call Stage 4 made).
    console.error("[research] scheduler tick failed to start", err);
  }
}

/** Idempotent - safe to call more than once. */
export function startResearchScheduler(): void {
  if (started) return;
  started = true;

  setInterval(() => void tick(), CHECK_IN_MS);
  void tick();
}
