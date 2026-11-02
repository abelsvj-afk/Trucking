// Lane 2 (Abel Intelligence Upgrade, Phase B) — the night shift's
// scheduler. Same in-process pattern as the industry-briefing and
// research schedulers: an hourly check-in tick, due-ness decided
// from database state (the newest consolidation_runs row), never
// from process memory - a restart delays a due run by at most the
// tick interval.
//
// Scope note: the bot brain is company-scoped by design (the
// Telegram store is built for TELEGRAM_COMPANY_ID), so this job
// consolidates that one company - the same scope Abel himself has.
//
// Fix round (pitfall hunt CD-1/CD-2):
// - CD-2: a due run takes a Postgres advisory lock (key 727002 -
//   the research tick's is 727001) on a dedicated connection for
//   the whole pass. Two Fly machines starting together both used
//   to see "due" and run the full LLM pass concurrently: duplicate
//   staged proposals, double spend, the morning report sent twice.
//   The second caller now skips cleanly and logs.
// - CD-1: the due-check is EXPORTED as runConsolidationIfDue() -
//   self-contained (it builds the same store/provider wiring this
//   scheduler uses) and safe to call hourly from anywhere. Its
//   ride is the Research lane's always-on invoker: once the owner
//   finishes that lane's setup, Supabase pg_cron wakes
//   POST /api/internal/research/run hourly even while Fly machines
//   sleep. The exact post-merge wiring is documented in
//   docs/runtime.md on the research lane ("Post-merge wiring —
//   Abel's night shift rides this invoker"): immediately after
//   runResearchTick("endpoint") in
//   src/app/api/internal/research/run/route.ts, dynamic-import
//   this module and `await runConsolidationIfDue()`. That endpoint
//   file does not exist on this branch (parallel lane), so the
//   wiring itself is a merge-time edit - nothing here fakes it.
//   Until it lands, the staleness half of the cure ships as
//   checkConsolidationHealth (consolidation.ts), surfaced as a
//   banner on More → What Abel remembers.

import { OpenAiProvider } from "@/services/ai/providers/openai";
import { getIndustryBriefingPool } from "@/services/db/industry-briefing-pool";
import type { BotBrainStore } from "@/services/bot/store";
import { createTelegramBrainStore } from "@/services/telegram/store";
import { createTelegramNotifier } from "@/services/telegram/notify";
import {
  latestConsolidationRunAt,
  runConsolidation,
  type ConsolidationResult,
} from "./consolidation";
import { buildSummaryPrompt } from "./summaries";

const CHECK_IN_MS = 60 * 60 * 1000;
const DUE_AFTER_MS = 20 * 60 * 60 * 1000;

/** Advisory-lock key for the consolidation pass (CD-2). Distinct from the research tick's 727001 - the two jobs never block each other. */
export const CONSOLIDATION_LOCK_KEY = 727002;

let started = false;

const EXTRACT_SYSTEM =
  "You read a truck driver's recent conversations with his assistant and extract DURABLE facts he stated about himself, " +
  "his work, his pay, his truck, his contacts, or his operation - facts worth remembering next week. " +
  "Return JSON: {\"facts\": [\"...\"]} with each fact as one plain sentence in his own words where possible. " +
  "Skip questions, small talk, one-off requests, and anything the assistant said. If nothing durable was stated, return an empty list.";

export interface ConsolidationLockHandle {
  release(): Promise<void>;
}

/** The production lock couldn't be taken because the job database isn't configured - the pass proceeds WITHOUT cross-machine protection (today's behavior) rather than never running, and says so loudly. */
const UNLOCKED: ConsolidationLockHandle = { release: async () => {} };

/**
 * CD-2: pg_try_advisory_lock on a dedicated connection from the
 * industry-briefing pool - the same direct-Postgres transport (and
 * the same database) the research tick locks through, so the lock
 * is real across machines. Resolves null when another run already
 * holds the lock (skip); the UNLOCKED sentinel when the pool isn't
 * configured at all.
 */
async function acquireConsolidationLock(): Promise<ConsolidationLockHandle | null> {
  let pool;
  try {
    pool = getIndustryBriefingPool();
  } catch {
    console.error(
      "[consolidation] INDUSTRY_BRIEFING_DB_URL is not configured - running this pass WITHOUT the cross-machine advisory lock (CD-2 protection inactive)",
    );
    return UNLOCKED;
  }
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean } & Record<string, unknown>>(
      "select pg_try_advisory_lock($1) as locked",
      [CONSOLIDATION_LOCK_KEY],
    );
    if (!rows[0]?.locked) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  return {
    release: async () => {
      try {
        await client.query("select pg_advisory_unlock($1)", [CONSOLIDATION_LOCK_KEY]);
      } catch {
        // Session locks die with the connection regardless - a
        // failed explicit unlock must not strand the pass.
      } finally {
        client.release();
      }
    },
  };
}

/** The real pass: provider wiring + runConsolidation, exactly what the scheduler tick has always run. */
async function runProductionPass(store: BotBrainStore): Promise<ConsolidationResult> {
  const provider = new OpenAiProvider();
  return runConsolidation({
    client: store.client,
    companyId: store.companyId,
    isEnabled: () => store.isMemoryConsolidationEnabled(),
    summarize: async (turns) => {
      const prompt = buildSummaryPrompt(turns);
      // provider.complete answers in JSON (its contract), so the
      // summary is asked for as a JSON field and unwrapped here.
      const raw = await provider.complete({
        system: `${prompt.system} Answer as JSON: {"summary": "<the summary, plain sentences separated by newlines>"}.`,
        user: prompt.user,
      });
      try {
        const parsed = JSON.parse(raw) as { summary?: unknown };
        if (typeof parsed.summary === "string" && parsed.summary.trim()) return parsed.summary.trim();
      } catch {
        // fall through to the raw text
      }
      return raw.trim();
    },
    extractCandidates: async (turns) => {
      const raw = await provider.complete({
        system: EXTRACT_SYSTEM,
        user: turns.map((t) => `${t.role}: ${t.text}`).join("\n"),
      });
      try {
        const parsed = JSON.parse(raw) as { facts?: unknown };
        return Array.isArray(parsed.facts)
          ? parsed.facts.filter((f): f is string => typeof f === "string")
          : [];
      } catch {
        return [];
      }
    },
  });
}

export interface ConsolidationDueDeps {
  store: BotBrainStore | null;
  acquireLock: () => Promise<ConsolidationLockHandle | null>;
  runPass: (store: BotBrainStore) => Promise<ConsolidationResult>;
  notify: (report: string) => Promise<void>;
}

/**
 * The night shift's due-check (CD-1): runs one consolidation pass
 * when the newest consolidation_runs row is at least 20h old (or
 * none exists), under the CD-2 advisory lock, and sends the
 * morning report line when there's anything to say. SELF-CONTAINED
 * and safe to call hourly from anywhere - the in-process scheduler
 * below calls it, and the research endpoint calls it post-merge
 * (see the header for the documented wiring). The zero-argument
 * call is the contract; the overrides exist for tests. Never
 * throws - failures log here, like the tick it replaces.
 */
export async function runConsolidationIfDue(
  overrides: Partial<ConsolidationDueDeps> = {},
): Promise<void> {
  try {
    const store =
      overrides.store !== undefined
        ? overrides.store
        : createTelegramBrainStore(process.env.TELEGRAM_COMPANY_ID ?? null);
    if (!store) return; // Telegram env not configured on this server - the job simply doesn't exist here.

    const lastRanAt = await latestConsolidationRunAt(store.client, store.companyId);
    if (lastRanAt && Date.now() - new Date(lastRanAt).getTime() < DUE_AFTER_MS) return;

    const acquireLock = overrides.acquireLock ?? acquireConsolidationLock;
    const lock = await acquireLock();
    if (!lock) {
      console.log("[consolidation] another run holds the advisory lock - skipping this due-check");
      return;
    }
    try {
      const runPass = overrides.runPass ?? runProductionPass;
      const result = await runPass(store);
      if (result.ran && result.report) {
        // The morning line (design §3.6 step 5): one quiet message,
        // only when there's something to say.
        const notify =
          overrides.notify ?? ((report: string) => createTelegramNotifier().notifyOwner(report));
        await notify(result.report);
      }
    } finally {
      await lock.release();
    }
  } catch (err) {
    console.error("[consolidation] scheduler tick failed", err);
  }
}

/** Idempotent - safe to call more than once. */
export function startConsolidationScheduler(): void {
  if (started) return;
  started = true;
  setInterval(() => void runConsolidationIfDue(), CHECK_IN_MS);
  void runConsolidationIfDue();
}
