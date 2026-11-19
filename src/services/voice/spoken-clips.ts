// Spoken lines in the owner's ElevenLabs voice (owner 2026-11-19: "it can
// use my eleven labs for generating the voice. Never re[-calling] the api
// ... if the said voice [clip] was already created and saved for future use").
//
// ONE rule: a line is generated at most once per voice. The clip is saved
// in the company's private storage under <company>/tts/<hash>.mp3, where
// the hash is of (voice, model, exact text). Every later request for the
// same line is served from storage — ElevenLabs is never called again for it.
//
// Free-first / honest cost: ElevenLabs characters come from HIS plan. A
// monthly character budget (ELEVENLABS_MONTHLY_CHAR_BUDGET, default 8,000)
// stops NEW generation when reached; saved clips keep playing, and the
// phone's own voice says anything new. The key is a server secret
// (ELEVENLABS_API_KEY, a Fly secret) — never in the repo, a log, or a
// response. Any failure falls back to the phone's voice: speech never
// goes silent because a provider is down.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "documents";
const SIGNED_URL_TTL_S = 60 * 60;
export const MAX_SPOKEN_CHARS = 300;
const DEFAULT_MODEL = "eleven_turbo_v2_5";
const DEFAULT_BUDGET = 8_000;

export interface VoiceConfig {
  apiKey: string | null;
  voiceId: string | null;
  modelId: string;
  monthlyBudgetChars: number;
}

/**
 * The voice: the ElevenLabs voice he picked for calls (companies.call_voice_id
 * "elevenlabs.<model>.<VoiceId>"), else ELEVENLABS_VOICE_ID. No key or no voice = not configured.
 */
export function voiceConfig(callVoiceId: string | null, env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const apiKey = env.ELEVENLABS_API_KEY?.trim() || null;
  let voiceId = env.ELEVENLABS_VOICE_ID?.trim() || null;
  let modelId = DEFAULT_MODEL;
  if (callVoiceId?.startsWith("elevenlabs.")) {
    const parts = callVoiceId.split(".");
    if (parts.length >= 3 && parts[parts.length - 1]) {
      voiceId = parts[parts.length - 1]!;
      modelId = parts.slice(1, -1).join(".") || DEFAULT_MODEL;
    }
  }
  const budget = Number(env.ELEVENLABS_MONTHLY_CHAR_BUDGET);
  return { apiKey, voiceId, modelId, monthlyBudgetChars: Number.isFinite(budget) && budget >= 0 ? budget : DEFAULT_BUDGET };
}

/** Normalised text: the cache key must not split on stray spaces. */
export function normaliseLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function clipKey(voiceId: string, modelId: string, text: string): string {
  return createHash("sha256").update(`${voiceId}|${modelId}|${normaliseLine(text)}`).digest("hex").slice(0, 40);
}

/** "2026-11" in the owner's zone (budgets reset on his calendar, never UTC's). */
export function budgetMonth(nowMs: number, timeZone = "America/New_York"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(new Date(nowMs));
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}

export type ClipResult =
  | { url: string; source: "saved" | "generated" }
  | { url: null; reason: "not_configured" | "budget_reached" | "too_long" | "unavailable" };

export interface ClipDeps {
  client: SupabaseClient;
  companyId: string;
  config: VoiceConfig;
  fetchFn?: typeof fetch;
  nowMs?: number;
}

async function signed(client: SupabaseClient, path: string): Promise<string | null> {
  const res = await client.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_S);
  return res.error || !res.data ? null : res.data.signedUrl;
}

async function readLedger(client: SupabaseClient, path: string): Promise<number> {
  const res = await client.storage.from(BUCKET).download(path);
  if (res.error || !res.data) return 0;
  try {
    const parsed = JSON.parse(await res.data.text()) as { chars?: unknown };
    return typeof parsed.chars === "number" && parsed.chars >= 0 ? parsed.chars : 0;
  } catch {
    return 0;
  }
}

/** A playable link for the line: saved if it exists, generated ONCE (within budget) if not. */
export async function spokenClip(text: string, deps: ClipDeps): Promise<ClipResult> {
  const line = normaliseLine(text);
  if (!line || line.length > MAX_SPOKEN_CHARS) return { url: null, reason: "too_long" };
  const { client, companyId, config } = deps;
  if (!config.apiKey || !config.voiceId) return { url: null, reason: "not_configured" };

  const path = `${companyId}/tts/${clipKey(config.voiceId, config.modelId, line)}.mp3`;
  // 1. Already made? Play it — no API call.
  const existing = await client.storage.from(BUCKET).list(`${companyId}/tts`, { search: path.split("/").pop() });
  if (!existing.error && (existing.data ?? []).some((o) => `${companyId}/tts/${o.name}` === path)) {
    const url = await signed(client, path);
    if (url) return { url, source: "saved" };
  }

  // 2. Budget for NEW clips this month.
  const nowMs = deps.nowMs ?? Date.now();
  const ledgerPath = `${companyId}/tts/ledger-${budgetMonth(nowMs)}.json`;
  const used = await readLedger(client, ledgerPath);
  if (used + line.length > config.monthlyBudgetChars) return { url: null, reason: "budget_reached" };

  // 3. Generate once, save, play.
  const fetchFn = deps.fetchFn ?? fetch;
  let audio: ArrayBuffer;
  try {
    const res = await fetchFn(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "xi-api-key": config.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text: line, model_id: config.modelId }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { url: null, reason: "unavailable" };
    audio = await res.arrayBuffer();
  } catch {
    return { url: null, reason: "unavailable" };
  }
  if (audio.byteLength === 0) return { url: null, reason: "unavailable" };
  const up = await client.storage.from(BUCKET).upload(path, new Blob([audio], { type: "audio/mpeg" }), { contentType: "audio/mpeg" });
  // The documents bucket allows insert + delete but not update (00007),
  // so the month's ledger is replaced by delete-then-insert.
  await client.storage.from(BUCKET).remove([ledgerPath]);
  await client.storage
    .from(BUCKET)
    .upload(ledgerPath, new Blob([JSON.stringify({ chars: used + line.length })], { type: "application/json" }), { contentType: "application/json" });
  if (up.error) return { url: null, reason: "unavailable" };
  const url = await signed(client, path);
  return url ? { url, source: "generated" } : { url: null, reason: "unavailable" };
}
