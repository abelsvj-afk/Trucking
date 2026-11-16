// Abel's standing rule: the backend self-reports when something is broken (owner 2026-11-16: two messages in a
// row got "Sorry - I couldn't process that one" with no reason). This turns a failed turn's error into one plain
// line saying WHAT broke and whether retrying can help. No error text, key or internal detail is ever shown -
// only the category.

export type TurnFailureKind = "ai_credit" | "ai_key" | "ai_busy" | "ai_timeout" | "ai_down" | "database" | "unknown";

function fieldOf(err: unknown, key: string): unknown {
  return err && typeof err === "object" ? (err as Record<string, unknown>)[key] : undefined;
}

export function classifyTurnFailure(err: unknown): TurnFailureKind {
  const status = Number(fieldOf(err, "status") ?? NaN);
  const code = String(fieldOf(err, "code") ?? fieldOf(fieldOf(err, "error"), "code") ?? "");
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (code === "insufficient_quota" || /insufficient_quota|exceeded your current quota|billing/i.test(message)) return "ai_credit";
  if (status === 401 || status === 403 || code === "invalid_api_key" || /OPENAI_API_KEY|api key/i.test(message)) return "ai_key";
  if (status === 429 || /rate limit/i.test(message)) return "ai_busy";
  if (/timed? ?out|timeout|ETIMEDOUT|aborted/i.test(message) || fieldOf(err, "name") === "APIConnectionTimeoutError") return "ai_timeout";
  if (status >= 500 || /APIConnectionError|ECONNRESET|fetch failed|EAI_AGAIN/i.test(`${String(fieldOf(err, "name"))} ${message}`)) return "ai_down";
  if (/supabase|postgres|PGRST|relation .* does not exist|column .* does not exist/i.test(message)) return "database";
  return "unknown";
}

const LINES: Record<TurnFailureKind, string> = {
  ai_credit:
    "⚠️ I couldn't answer that: my AI account (OpenAI) is out of credit or over its limit, so every message that needs thinking will fail until it's topped up. Nothing was recorded.",
  ai_key: "⚠️ I couldn't answer that: my AI key was refused, so I can't think right now. The key needs to be checked. Nothing was recorded.",
  ai_busy: "⚠️ I couldn't answer that: my AI service is rate-limiting me right now. Try again in a minute. Nothing was recorded.",
  ai_timeout: "⚠️ I couldn't answer that: my AI service didn't respond in time. Try again in a moment. Nothing was recorded.",
  ai_down: "⚠️ I couldn't answer that: I couldn't reach my AI service. Try again in a few minutes. Nothing was recorded.",
  database: "⚠️ I couldn't answer that: reading your records failed on the server side. That needs fixing on my end. Nothing was recorded.",
  unknown: "⚠️ I couldn't answer that because something broke on my end (logged for repair). Try again in a moment. Nothing was recorded.",
};

/** The reply for a failed turn. A forwarded dispatch keeps the pointer to the app's Dispatch helper. */
export function turnFailureReply(err: unknown, forwarded: boolean): string {
  const line = LINES[classifyTurnFailure(err)];
  return forwarded ? `${line}\nYou can also paste the dispatch into the app: More → Dispatch helper.` : line;
}
