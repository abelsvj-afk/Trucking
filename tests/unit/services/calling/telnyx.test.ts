// Telnyx client + webhook signature - docs/design/outbound-calling.md.
// The live API is never hit: fetch is a canned stub, and the signature
// test signs with a throwaway in-test Ed25519 keypair.
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CallingConfig } from "@/services/calling/config";
import {
  dialOutboundCall,
  listTelnyxVoices,
  startAssistant,
  TelnyxError,
  verifyTelnyxSignature,
  type FetchImpl,
} from "@/services/calling/telnyx";

const CONFIG: CallingConfig = {
  telnyxApiKey: "test-key",
  phoneNumber: "+15551234567",
  connectionId: "conn-1",
  assistantId: "asst-1",
  publicKey: null,
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("dialOutboundCall", () => {
  it("posts to /v2/calls and returns the call_control_id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { call_control_id: "cc-1" } }));
    const result = await dialOutboundCall(CONFIG, fetchImpl as unknown as FetchImpl, "+15559876543", "+15551234567");
    expect(result.callControlId).toBe("cc-1");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe("https://api.telnyx.com/v2/calls");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      connection_id: "conn-1",
      to: "+15559876543",
      from: "+15551234567",
    });
  });

  it("throws a TelnyxError carrying the API's detail, not the key", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errors: [{ detail: "Invalid phone number" }] }, 400),
    );
    const asFetch = fetchImpl as unknown as FetchImpl;
    await expect(dialOutboundCall(CONFIG, asFetch, "bad", "+15551234567")).rejects.toThrow(TelnyxError);
    await expect(dialOutboundCall(CONFIG, asFetch, "bad", "+15551234567")).rejects.toThrow("Invalid phone number");
  });
});

describe("startAssistant", () => {
  it("sends the greeting, dynamic variables, and the voice he picked", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: {} }));
    await startAssistant(CONFIG, fetchImpl as unknown as FetchImpl, "cc-1", {
      assistantId: "asst-1",
      greeting: "Hi Marcus, this is Abel calling from Road to Legacy Trucking about an ETA check.",
      dynamicVariables: { to_name: "Marcus", purpose: "an ETA check", say: "Ask when he gets there." },
      voice: "elevenlabs.eleven_turbo_v2_5.abc123",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe("https://api.telnyx.com/v2/calls/cc-1/actions/ai_assistant_start");
    expect(JSON.parse(init.body as string)).toEqual({
      assistant: {
        id: "asst-1",
        greeting: "Hi Marcus, this is Abel calling from Road to Legacy Trucking about an ETA check.",
        dynamic_variables: { to_name: "Marcus", purpose: "an ETA check", say: "Ask when he gets there." },
        voice_settings: { voice: "elevenlabs.eleven_turbo_v2_5.abc123" },
      },
    });
  });

  it("sends no voice_settings when he uses the Telnyx default", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: {} }));
    await startAssistant(CONFIG, fetchImpl as unknown as FetchImpl, "cc-1", {
      assistantId: "asst-1",
      greeting: "Hi.",
      dynamicVariables: {},
      voice: null,
    });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].body as string);
    expect(body.assistant.voice_settings).toBeUndefined();
  });
});

describe("listTelnyxVoices", () => {
  it("parses the catalog and returns an empty list on a refusal", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { voice_id: "elevenlabs.eleven_turbo_v2_5.abc123", name: "Marcus (ElevenLabs)", provider: "elevenlabs" },
          { voice_id: "Telnyx.KokoroTTS.af_heart", name: "Heart", provider: "telnyx" },
          { name: "no id at all" },
        ],
      }),
    );
    const voices = await listTelnyxVoices(CONFIG, fetchImpl as unknown as FetchImpl);
    expect(voices).toEqual([
      { id: "elevenlabs.eleven_turbo_v2_5.abc123", label: "Marcus (ElevenLabs)", provider: "elevenlabs" },
      { id: "Telnyx.KokoroTTS.af_heart", label: "Heart", provider: "telnyx" },
    ]);
    const failing = vi.fn(async () => jsonResponse({}, 401));
    expect(await listTelnyxVoices(CONFIG, failing as unknown as FetchImpl)).toEqual([]);
  });
});

describe("verifyTelnyxSignature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const rawB64 = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ data: { event_type: "call.answered" } });
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey).toString("base64");

  it("accepts a real signature, PEM or raw key", () => {
    expect(verifyTelnyxSignature(pem, timestamp, body, signature)).toBe(true);
    expect(verifyTelnyxSignature(rawB64, timestamp, body, signature)).toBe(true);
  });

  it("refuses a wrong signature, a stale timestamp, and a missing key", () => {
    expect(verifyTelnyxSignature(pem, timestamp, body, Buffer.alloc(64).toString("base64"))).toBe(false);
    expect(verifyTelnyxSignature(pem, String(Math.floor(Date.now() / 1000) - 3600), body, signature)).toBe(false);
    expect(verifyTelnyxSignature(null, timestamp, body, signature)).toBe(false);
    expect(verifyTelnyxSignature(pem, timestamp, body, null)).toBe(false);
  });
});
