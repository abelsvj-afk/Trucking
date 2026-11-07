// The in-process poller (same pattern as the reminder scheduler). Each mailbox (dispatch@, owner@) has its own timer, its
// own cursor and its own health: a mailbox with no config is OFF and says so, and one failing never stops the other. One poll
// per mailbox at a time; a tick that finds the previous poll still running is skipped. An error never escapes the timer.

import { OpenAiProvider } from "@/services/ai/providers/openai";
import { createTelegramBrainStore } from "@/services/telegram/store";
import { createTelegramNotifier } from "@/services/telegram/notify";
import { getEmailConfig, MAILBOXES, type Mailbox } from "./config";
import { pollOnce, type IngestDeps } from "./ingest";
import { createEmailStore } from "./store";

const started = new Set<Mailbox>();
const running = new Set<Mailbox>();

export async function runEmailPoll(mailbox: Mailbox, overrides: Partial<IngestDeps> = {}): Promise<{ skipped?: string; stored?: number }> {
  if (running.has(mailbox)) return { skipped: "previous poll still running" };
  const cfg = getEmailConfig(mailbox);
  const config = overrides.config ?? (cfg.ok ? cfg.config : null);
  if (!config) return { skipped: "email not configured" };
  running.add(mailbox);
  try {
    const brain = overrides.brain !== undefined ? overrides.brain : createTelegramBrainStore(process.env.TELEGRAM_COMPANY_ID ?? null);
    if (!brain) return { skipped: "no company store here" };
    const aiOn = (await brain.isBotChatEnabled().catch(() => false)) && (await brain.isDispatchHelperEnabled().catch(() => false));
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
    console.error(`[email] ${mailbox} poll failed`, err instanceof Error ? err.name : "error");
    return { skipped: "error" };
  } finally {
    running.delete(mailbox);
  }
}

export function startEmailScheduler(): void {
  for (const mailbox of MAILBOXES) {
    if (started.has(mailbox)) continue;
    started.add(mailbox);
    const cfg = getEmailConfig(mailbox);
    if (!cfg.ok) {
      console.log(`[email] ${mailbox} inbox is OFF -`, cfg.reason);
      continue;
    }
    void runEmailPoll(mailbox);
    setInterval(() => {
      void runEmailPoll(mailbox);
    }, cfg.config.intervalMs);
  }
}
