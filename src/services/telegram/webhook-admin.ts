// Owner-only Telegram webhook report + repair (King's root-cause relay, 2026-11-06; docs/design/driver-mvp.md §4).
// The webhook was registered for message updates only, so inline-button taps (callback_query) and Live Location
// follow-up fixes (edited_message) were never delivered. The bot token and the webhook secret live only in the
// server's environment, so the repair has to run here, inside the app:
//  - REPORT: getWebhookInfo, in plain words - which update types Telegram delivers, the pending count, the last error.
//  - REPAIR: setWebhook for the EXISTING url (never one supplied by a caller) with the three update types the app
//    needs, reusing the secret from the environment, then a fresh getWebhookInfo to confirm.
// The token and the secret are never returned, logged, or put in an error message; only the url's HOST is shown.

export const REQUIRED_UPDATES = ["message", "edited_message", "callback_query"] as const;
export type RequiredUpdate = (typeof REQUIRED_UPDATES)[number];

export interface WebhookReport {
  /** False when the server has no bot token at all. */
  configured: boolean;
  /** False when Telegram has no webhook URL for the bot. */
  registered: boolean;
  /** Host only - the path and the secret never leave the server. */
  host: string | null;
  /** null = Telegram's default list (which includes all three required types). */
  allowedUpdates: string[] | null;
  missing: RequiredUpdate[];
  pendingCount: number;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  /** Whether the server has a webhook secret to send back to Telegram. */
  secretConfigured: boolean;
  healthy: boolean;
  /** Plain-language findings for the screen, most important first. */
  findings: string[];
}

type Fetch = typeof fetch;

/** Removes anything shaped like a bot token from text that came back from outside. */
export function scrubToken(text: string): string {
  return text.replace(/\b\d{6,}:[A-Za-z0-9_-]{25,}\b/g, "[token]");
}

interface TelegramWebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
  allowed_updates?: string[];
}

async function callTelegram<T>(botToken: string, method: string, body: unknown, fetchImpl: Fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    // Never surface the thrown error: its text can carry the request URL, which contains the token.
    throw new Error("Couldn't reach Telegram from the server.");
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!res.ok || !json?.ok) {
    throw new Error(`Telegram refused ${method}${json?.description ? `: ${scrubToken(json.description)}` : "."}`);
  }
  return json.result as T;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function buildWebhookReport(info: TelegramWebhookInfo | null, secretConfigured: boolean, configured = true): WebhookReport {
  if (!configured || info === null) {
    return {
      configured: false, registered: false, host: null, allowedUpdates: null, missing: [], pendingCount: 0,
      lastErrorMessage: null, lastErrorAt: null, secretConfigured, healthy: false,
      findings: ["The Telegram bot isn't set up on the server (no bot token), so there is nothing to check."],
    };
  }
  const registered = typeof info.url === "string" && info.url.length > 0;
  const list = Array.isArray(info.allowed_updates) && info.allowed_updates.length > 0 ? info.allowed_updates : null;
  const missing = list ? REQUIRED_UPDATES.filter((u) => !list.includes(u)) : [];
  const lastErrorMessage = info.last_error_message ? scrubToken(info.last_error_message) : null;
  const lastErrorAt = typeof info.last_error_date === "number" ? new Date(info.last_error_date * 1000).toISOString() : null;
  const pendingCount = info.pending_update_count ?? 0;

  const findings: string[] = [];
  if (!registered) {
    findings.push("Telegram has no webhook for the bot, so nothing you send reaches Abel. Re-registering needs the web address, which the server can't invent - King sets it once with setWebhook.");
  }
  if (registered && missing.includes("callback_query")) {
    findings.push("Telegram was told not to send button taps, so inline buttons (like the photo-purpose buttons) do nothing.");
  }
  if (registered && missing.includes("edited_message")) {
    findings.push("Telegram was told not to send message edits, and Live Location's movement updates arrive as edits - so the server can see where you start sharing but not that you are moving, and the automatic duty switch can't fire.");
  }
  if (registered && missing.includes("message")) {
    findings.push("Telegram was told not to send ordinary messages at all.");
  }
  if (registered && lastErrorMessage && (pendingCount > 0 || missing.length === 0)) {
    findings.push(`Telegram's last delivery problem${lastErrorAt ? ` (${lastErrorAt})` : ""}: ${lastErrorMessage}${pendingCount > 0 ? ` - ${pendingCount} update(s) are waiting.` : ""}`);
  }
  if (registered && !secretConfigured) {
    findings.push("The server has no webhook secret configured, so it accepts any delivery without the secret header.");
  }
  const healthy = registered && missing.length === 0 && secretConfigured && !(pendingCount > 0 && lastErrorMessage);
  if (healthy) findings.unshift("Telegram is delivering your messages, message edits (Live Location) and button taps.");
  return {
    configured: true, registered, host: registered ? hostOf(info.url!) : null, allowedUpdates: list, missing,
    pendingCount, lastErrorMessage, lastErrorAt, secretConfigured, healthy, findings,
  };
}

export async function getWebhookReport(
  env: { botToken: string | null; webhookSecret: string | null },
  fetchImpl: Fetch = fetch,
): Promise<WebhookReport> {
  if (!env.botToken) return buildWebhookReport(null, Boolean(env.webhookSecret), false);
  const info = await callTelegram<TelegramWebhookInfo>(env.botToken, "getWebhookInfo", {}, fetchImpl);
  return buildWebhookReport(info, Boolean(env.webhookSecret));
}

export interface RepairResult {
  repaired: boolean;
  before: WebhookReport;
  after: WebhookReport;
  message: string;
}

/**
 * Re-registers the EXISTING webhook URL with the update types the app needs, keeping the secret. Refuses (and says why)
 * when there is no bot token or no existing URL - it never accepts a URL from a caller.
 */
export async function repairWebhook(
  env: { botToken: string | null; webhookSecret: string | null },
  fetchImpl: Fetch = fetch,
): Promise<RepairResult> {
  const before = await getWebhookReport(env, fetchImpl);
  if (!env.botToken) return { repaired: false, before, after: before, message: before.findings[0]! };
  const current = await callTelegram<TelegramWebhookInfo>(env.botToken, "getWebhookInfo", {}, fetchImpl);
  if (!current.url) {
    return { repaired: false, before, after: before, message: "There is no existing webhook address to re-register, so nothing was changed." };
  }
  await callTelegram<boolean>(
    env.botToken,
    "setWebhook",
    {
      url: current.url,
      allowed_updates: [...REQUIRED_UPDATES],
      // The secret rides back to Telegram exactly as the app expects it on every delivery.
      ...(env.webhookSecret ? { secret_token: env.webhookSecret } : {}),
      // Never throw away what is already waiting.
      drop_pending_updates: false,
    },
    fetchImpl,
  );
  const after = await getWebhookReport(env, fetchImpl);
  return {
    repaired: after.registered && after.missing.length === 0,
    before,
    after,
    message: after.missing.length === 0
      ? "Done - Telegram will now send messages, message edits (Live Location) and button taps."
      : "I re-registered it, but Telegram still isn't listing every update type - check again in a minute.",
  };
}
