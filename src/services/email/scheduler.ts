// The in-process poller (same pattern as the reminder scheduler). Config missing = does nothing and says so. One poll at a
// time; a tick that finds the previous poll still running is skipped. A thrown error never escapes the timer.

import { OpenAiProvider } from "@/services/ai/providers/openai";
import { createTelegramBrainStore } from "@/services/telegram/store";
import { createTelegramNotifier } from "@/services/telegram/notify";
import { getEmailConfig } from "./config";
import { pollOnce, type IngestDeps } from "./ingest";
import { createEmailStore } from "./store";

let started = false;
let running = false;

export async function runEmailPoll(overrides: Partial<IngestDeps> = {}): Promise<{ skipped?: string; stored?: number }> {
  if (running) return { skipped: "previous poll still running" };
  const cfg = getEmailConfig();
  if (!cfg.ok && !overrides.config) return { skipped: "email not configured" };
  running = true;
  try {
    const brain = overrides.brain !== undefined ? overrides.brain : createTelegramBrainStore(process.env.TELEGRAM_COMPANY_ID ?? null);
    if (!brain) return { skipped: "no company store here" };
    const aiOn = (await brain.isBotChatEnabled().catch(() => false)) && (await brain.isDispatchHelperEnabled().catch(() => false));
    const config = overrides.config ?? (cfg.ok ? cfg.config : null);
    if (!config) return { skipped: "email not configured" };
    const result = await pollOnce({
      config,
      emailStore: overrides.emailStore ?? createEmailStore(brain.client, brain.companyId),
      brain,
      provider: overrides.provider !== undefined ? overrides.provider : aiOn ? () => new OpenAiProvider() : null,
      notify: overrides.notify ?? ((text) => createTelegramNotifier().notifyOwner(text)),
      now: overrides.now ?? (() => new Date()),
      open: overrides.open,
    });
    return { stored: result.stored };
  } catch (err) {
    console.error("[email] poll failed", err instanceof Error ? err.name : "error");
    return { skipped: "error" };
  } finally {
    running = false;
  }
}

export function startEmailScheduler(): void {
  if (started) return;
  started = true;
  const cfg = getEmailConfig();
  if (!cfg.ok) {
    console.log("[email] company inbox is OFF -", cfg.reason);
    return;
  }
  void runEmailPoll();
  setInterval(() => {
    void runEmailPoll();
  }, cfg.config.intervalMs);
}
