// Spoken lines in his ElevenLabs voice: generated ONCE, then played from storage (owner 2026-11-19).
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { budgetMonth, clipKey, spokenClip, voiceConfig } from "@/services/voice/spoken-clips";

function fakeStorage() {
  const files = new Map<string, string>();
  const bucket = {
    list: async (folder: string, opts: { search: string }) => ({
      data: [...files.keys()].filter((k) => k.startsWith(folder + "/") && k.endsWith(opts.search)).map((k) => ({ name: k.slice(folder.length + 1) })),
      error: null,
    }),
    createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed/${path}` }, error: null }),
    download: async (path: string) => (files.has(path) ? { data: new Blob([files.get(path)!]), error: null } : { data: null, error: { message: "nf" } }),
    upload: async (path: string, blob: Blob) => {
      if (files.has(path)) return { error: { message: "exists" } };
      files.set(path, await blob.text());
      return { error: null };
    },
    remove: async (paths: string[]) => {
      paths.forEach((p) => files.delete(p));
      return { error: null };
    },
  };
  return { client: { storage: { from: () => bucket } } as unknown as SupabaseClient, files };
}

const config = voiceConfig("elevenlabs.eleven_turbo_v2_5.VOICE123", { ELEVENLABS_API_KEY: "sk_test_placeholder" } as unknown as NodeJS.ProcessEnv);
const NOW = Date.parse("2026-11-19T15:00:00Z");

describe("spoken clips", () => {
  it("uses the ElevenLabs voice he picked for calls", () => {
    expect(config).toMatchObject({ voiceId: "VOICE123", modelId: "eleven_turbo_v2_5", monthlyBudgetChars: 8000 });
  });

  it("generates a line once, then serves the saved clip — never calling ElevenLabs again for it", async () => {
    const { client } = fakeStorage();
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const deps = { client, companyId: "c1", config, fetchFn: fetchFn as unknown as typeof fetch, nowMs: NOW };
    const first = await spokenClip("In 4.4 miles, turn right onto US-231.", deps);
    const second = await spokenClip("In  4.4 miles, turn right onto US-231. ", deps);
    expect(first).toMatchObject({ source: "generated" });
    expect(second).toMatchObject({ source: "saved" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // the key goes only in the request header to ElevenLabs, never in an answer
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("sk_test_placeholder");
    expect(JSON.stringify(first)).not.toContain("sk_test_placeholder");
  });

  it("stops making NEW clips at the monthly budget; saved ones keep playing", async () => {
    const { client } = fakeStorage();
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    const deps = { client, companyId: "c1", config: { ...config, monthlyBudgetChars: 40 }, fetchFn: fetchFn as unknown as typeof fetch, nowMs: NOW };
    expect(await spokenClip("Road work ahead in 1.8 miles.", deps)).toMatchObject({ source: "generated" });
    expect(await spokenClip("Low bridge ahead in about 3 miles.", deps)).toEqual({ url: null, reason: "budget_reached" });
    expect(await spokenClip("Road work ahead in 1.8 miles.", deps)).toMatchObject({ source: "saved" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("no key = not configured; provider down = unavailable (the phone's voice speaks either way)", async () => {
    const { client } = fakeStorage();
    expect(await spokenClip("Hi.", { client, companyId: "c1", config: voiceConfig(null, {} as unknown as NodeJS.ProcessEnv) })).toEqual({ url: null, reason: "not_configured" });
    const down = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await spokenClip("Hi.", { client, companyId: "c1", config, fetchFn: down as unknown as typeof fetch })).toEqual({ url: null, reason: "unavailable" });
  });

  it("the cache key is per voice, and the budget month is his, not UTC's", () => {
    expect(clipKey("A", "m", "x")).not.toBe(clipKey("B", "m", "x"));
    expect(budgetMonth(Date.parse("2026-12-01T03:00:00Z"))).toBe("2026-11"); // still Nov 30 in Eastern
  });
});
