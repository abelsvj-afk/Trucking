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

import { OpenAiProvider } from "@/services/ai/providers/openai";
import { createTelegramBrainStore } from "@/services/telegram/store";
import { createTelegramNotifier } from "@/services/telegram/notify";
import { runConsolidation } from "./consolidation";
import { buildSummaryPrompt } from "./summaries";

const CHECK_IN_MS = 60 * 60 * 1000;
const DUE_AFTER_MS = 20 * 60 * 60 * 1000;

let started = false;

const EXTRACT_SYSTEM =
  "You read a truck driver's recent conversations with his assistant and extract DURABLE facts he stated about himself, " +
  "his work, his pay, his truck, his contacts, or his operation - facts worth remembering next week. " +
  "Return JSON: {\"facts\": [\"...\"]} with each fact as one plain sentence in his own words where possible. " +
  "Skip questions, small talk, one-off requests, and anything the assistant said. If nothing durable was stated, return an empty list.";

async function tick(): Promise<void> {
  try {
    const store = createTelegramBrainStore(process.env.TELEGRAM_COMPANY_ID ?? null);
    if (!store) return; // Telegram env not configured on this server - the job simply doesn't exist here.
    const provider = new OpenAiProvider();

    const { data: lastRun } = await store.client
      .from("consolidation_runs")
      .select("ran_at")
      .eq("company_id", store.companyId)
      .order("ran_at", { ascending: false })
      .limit(1);
    const lastRanAt = (lastRun ?? [])[0]?.ran_at as string | undefined;
    if (lastRanAt && Date.now() - new Date(lastRanAt).getTime() < DUE_AFTER_MS) return;

    const result = await runConsolidation({
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

    if (result.ran && result.report) {
      // The morning line (design §3.6 step 5): one quiet message,
      // only when there's something to say.
      await createTelegramNotifier().notifyOwner(result.report);
    }
  } catch (err) {
    console.error("[consolidation] scheduler tick failed", err);
  }
}

/** Idempotent - safe to call more than once. */
export function startConsolidationScheduler(): void {
  if (started) return;
  started = true;
  setInterval(() => void tick(), CHECK_IN_MS);
  void tick();
}
