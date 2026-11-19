// Minimal Telnyx client (docs/design/outbound-calling.md). Plain fetch -
// no new dependency. Only the calls the app needs: dial out, attach the
// AI assistant, list TTS voices, and verify webhook signatures. Secrets
// never appear in an error message or a log.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { CallingConfig } from "./config";

export class TelnyxError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TelnyxError";
  }
}

export type FetchImpl = typeof fetch;

const TELNYX_API = "https://api.telnyx.com/v2";
const TIMEOUT_MS = 10_000;

async function telnyxRequest(
  config: CallingConfig,
  fetchImpl: FetchImpl,
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!config.telnyxApiKey) throw new TelnyxError("Telnyx isn't set up yet.", 0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${TELNYX_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.telnyxApiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const errors = json?.errors;
      const detail =
        Array.isArray(errors) && errors.length > 0 && typeof errors[0] === "object" && errors[0] !== null
          ? String((errors[0] as Record<string, unknown>).detail ?? (errors[0] as Record<string, unknown>).title ?? "")
          : "";
      throw new TelnyxError(
        detail ? `Telnyx refused the call (${res.status}): ${detail}` : `Telnyx refused the call (${res.status}).`,
        res.status,
      );
    }
    return (json?.data ?? {}) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof TelnyxError) throw err;
    throw new TelnyxError(
      err instanceof Error && err.name === "AbortError"
        ? "Telnyx didn't answer in time."
        : "Couldn't reach Telnyx.",
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface DialResult {
  callControlId: string;
}

/** Place the outbound leg: POST /v2/calls. Returns the call_control_id that drives the call. */
export async function dialOutboundCall(
  config: CallingConfig,
  fetchImpl: FetchImpl,
  to: string,
  from: string,
): Promise<DialResult> {
  const data = await telnyxRequest(config, fetchImpl, "/calls", "POST", {
    connection_id: config.connectionId,
    to,
    from,
  });
  const callControlId = typeof data.call_control_id === "string" ? data.call_control_id : "";
  if (!callControlId) throw new TelnyxError("Telnyx dialed but didn't return a call id.", 0);
  return { callControlId };
}

export interface AssistantStartOptions {
  assistantId: string;
  greeting: string;
  /** Merged into the assistant's stored dynamic variables (per-call values win). */
  dynamicVariables: Record<string, string>;
  /** The voice he picked, or null to keep the assistant's stored voice. */
  voice: string | null;
}

/**
 * Attach the AI assistant to a live call: POST
 * /v2/calls/:call_control_id/actions/ai_assistant_start. voice_settings
 * REPLACES the assistant's stored voice settings, so only `voice` is sent.
 */
export async function startAssistant(
  config: CallingConfig,
  fetchImpl: FetchImpl,
  callControlId: string,
  options: AssistantStartOptions,
): Promise<void> {
  const assistant: Record<string, unknown> = {
    id: options.assistantId,
    greeting: options.greeting,
    dynamic_variables: options.dynamicVariables,
  };
  if (options.voice) assistant.voice_settings = { voice: options.voice };
  await telnyxRequest(
    config,
    fetchImpl,
    `/calls/${encodeURIComponent(callControlId)}/actions/ai_assistant_start`,
    "POST",
    { assistant },
  );
}

export interface TelnyxVoiceOption {
  id: string;
  label: string;
  provider: string;
}

/**
 * The live TTS voice catalog: GET /v2/text-to-speech/voices. Parsed
 * defensively - an unexpected shape returns an empty list and the UI
 * falls back to the Telnyx default, never a guessed voice.
 */
export async function listTelnyxVoices(
  config: CallingConfig,
  fetchImpl: FetchImpl,
): Promise<TelnyxVoiceOption[]> {
  if (!config.telnyxApiKey) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${TELNYX_API}/text-to-speech/voices`, {
      headers: { Authorization: `Bearer ${config.telnyxApiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const rows = Array.isArray(json?.data) ? (json.data as Record<string, unknown>[]) : [];
    const out: TelnyxVoiceOption[] = [];
    for (const row of rows) {
      const id = typeof row.voice_id === "string" ? row.voice_id : typeof row.id === "string" ? row.id : "";
      if (!id) continue;
      const provider = typeof row.provider === "string" ? row.provider : "";
      const name = typeof row.name === "string" && row.name ? row.name : id;
      out.push({ id, label: name, provider });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify a Telnyx webhook signature (Ed25519 over `timestamp + raw body`).
 * The portal public key is either a PEM block or the raw 32-byte key in
 * base64. Returns false on ANY problem - bad key, bad signature, stale
 * timestamp (older than 5 minutes), or malformed input. Never throws.
 */
export function verifyTelnyxSignature(
  publicKey: string | null | undefined,
  timestamp: string | null | undefined,
  rawBody: string,
  signatureB64: string | null | undefined,
): boolean {
  try {
    if (!publicKey || !timestamp || !signatureB64) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
    const signature = Buffer.from(signatureB64, "base64");
    if (signature.length !== 64) return false;
    let key;
    if (publicKey.includes("BEGIN PUBLIC KEY")) {
      key = createPublicKey(publicKey);
    } else {
      const raw = Buffer.from(publicKey.replace(/\s/g, ""), "base64");
      if (raw.length !== 32) return false;
      key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    }
    const message = Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(rawBody, "utf8")]);
    const ok = cryptoVerify(null, message, key, signature);
    return ok === true;
  } catch {
    return false;
  }
}
