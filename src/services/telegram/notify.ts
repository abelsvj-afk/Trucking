// Outbound Telegram notification for the Deep Research Engine
// (docs/design/research-engine.md §5). Uses the same bot config as the
// webhook (services/telegram/dispatch-bot.ts's getTelegramConfig): the
// token + the owner's allowlisted chat id. There is exactly one
// possible recipient - the owner - and nothing is ever sent anywhere
// else. Best-effort by contract: callers treat a false return as
// "not notified", never as a failed run.

import { getTelegramConfig } from "./dispatch-bot";

export interface TelegramNotifier {
  /** True only when a message was actually accepted by Telegram. */
  notifyOwner(text: string): Promise<boolean>;
}

export function createTelegramNotifier(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): TelegramNotifier {
  const config = getTelegramConfig(env);
  return {
    async notifyOwner(text: string): Promise<boolean> {
      if (!config.botToken || !config.allowedChatId) return false;
      try {
        const res = await fetchFn(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: config.allowedChatId, text }),
        });
        if (!res.ok) {
          console.error("[research] telegram notify failed", res.status);
          return false;
        }
        return true;
      } catch (err) {
        console.error("[research] telegram notify failed", err);
        return false;
      }
    },
  };
}
