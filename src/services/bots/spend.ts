// Model tiers + hard spending cap (Phase 0 baseline).
// Engine: his ChatGPT API key, topped up $10 at a time. Cheap model
// scans; a stronger model ranks the best few only. A hard cap stops
// bot model calls when hit, and the bots say so plainly instead of
// going quiet.
//
// Honesty note, built in: the ledger tracks ESTIMATES, not bills.
// OpenAI bills the account; token counts are estimated at ~4 chars
// per token and prices are the documented estimates in the table
// below. The cap trips early on purpose — an estimate that overshoots
// the real bill is safe; one that undershoots is not. Exact spend is
// whatever OpenAI's dashboard says, and the bots never quote it as
// their own figure.

export type ModelTier = "scan" | "rank";

/** Cheap model: scans boards, reads forwards, drafts. */
export function scanModel(env: Record<string, string | undefined> = process.env): string {
  return env.BOT_SCAN_MODEL ?? env.OPENAI_MODEL ?? "gpt-4o-mini";
}

/**
 * Stronger model: ranks the best few only. Defaults to the scan model
 * — no model name is invented here. Set BOT_RANK_MODEL to whatever
 * OpenAI's docs list as current when a stronger ranker is wanted.
 */
export function rankModel(env: Record<string, string | undefined> = process.env): string {
  return env.BOT_RANK_MODEL ?? scanModel(env);
}

export function modelForTier(tier: ModelTier, env: Record<string, string | undefined> = process.env): string {
  return tier === "rank" ? rankModel(env) : scanModel(env);
}

/**
 * Estimated price, US cents per 1M tokens. ESTIMATES — see the module
 * note. The rank row is a gpt-4o-class estimate; if BOT_RANK_MODEL
 * names a different model, set BOT_MODEL_PRICES_JSON to override.
 */
export const ESTIMATED_PRICES_CENTS_PER_MILLION_TOKENS: Record<ModelTier, { input: number; output: number }> = {
  scan: { input: 15, output: 60 },
  rank: { input: 250, output: 1000 },
};

/** Rough token estimate: ~4 characters per token. An estimate. */
export function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

export interface CallCostInput {
  tier: ModelTier;
  inputChars: number;
  outputChars: number;
}

/** Estimated cost of one model call, in integer cents (rounded up). */
export function estimateCallCostCents(input: CallCostInput): number {
  const prices = ESTIMATED_PRICES_CENTS_PER_MILLION_TOKENS[input.tier];
  const inputTokens = estimateTokens(input.inputChars);
  const outputTokens = estimateTokens(input.outputChars);
  const cents = (inputTokens * prices.input + outputTokens * prices.output) / 1_000_000;
  return Math.max(1, Math.ceil(cents));
}

/** Monthly hard cap, in cents. Default $10 — one top-up. */
export function monthlyCapCents(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.BOT_MONTHLY_SPEND_CAP_CENTS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 1000;
}

/** First instant of the current UTC month — bookkeeping only, never user-facing. */
export function monthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** What the bots say when the cap is hit. Plain words, no jargon. */
export const SPEND_CAP_REACHED_TEXT =
  "The bot spending cap for this month is reached, so I'm pausing model calls until it resets. " +
  "Nothing was booked or sent — ask me again next month, or raise the cap.";
