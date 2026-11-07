// King's root cause (2026-11-06): the webhook was registered for message updates only. The owner-only report +
// repair must (a) say so plainly, (b) re-register the EXISTING address with all three update types, reusing the
// server's secret, and (c) never let the bot token or the secret out.

import { describe, expect, it, vi } from "vitest";
import { buildWebhookReport, getWebhookReport, repairWebhook, scrubToken } from "@/services/telegram/webhook-admin";

const TOKEN = "123456789:AAExampleExampleExampleExampleExample1";
const SECRET = "super-secret-header-value";
const URL_ON_FLY = "https://example-app.fly.dev/api/telegram/webhook";

type Call = { method: string; body: Record<string, unknown> };

/** A fake Telegram that remembers the registered webhook and records every call. */
function fakeTelegram(initial: { url?: string; allowed_updates?: string[]; pending_update_count?: number; last_error_message?: string }) {
  const state = { ...initial };
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === "setWebhook") {
      state.url = body.url as string;
      state.allowed_updates = body.allowed_updates as string[];
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: { ...state } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, state };
}

const ENV = { botToken: TOKEN, webhookSecret: SECRET };

describe("webhook report", () => {
  it("names the two dead features when only message updates are registered", () => {
    const r = buildWebhookReport({ url: URL_ON_FLY, allowed_updates: ["message"] }, true);
    expect(r.healthy).toBe(false);
    expect(r.missing).toEqual(["edited_message", "callback_query"]);
    const text = r.findings.join(" ");
    expect(text).toMatch(/button taps/);
    expect(text).toMatch(/Live Location/);
    expect(text).toMatch(/automatic duty switch/);
    expect(r.host).toBe("example-app.fly.dev");
  });
  it("Telegram's default list (no allowed_updates) is healthy", () => {
    const r = buildWebhookReport({ url: URL_ON_FLY }, true);
    expect(r).toMatchObject({ healthy: true, missing: [], allowedUpdates: null });
    expect(r.findings[0]).toMatch(/delivering/);
  });
  it("no webhook at all, and no bot token, are reported plainly", () => {
    expect(buildWebhookReport({ url: "" }, true).findings.join(" ")).toMatch(/no webhook/);
    expect(buildWebhookReport(null, false, false).findings[0]).toMatch(/isn't set up on the server/);
  });
  it("a delivery error with updates waiting makes it unhealthy even with every type listed", () => {
    const r = buildWebhookReport({ url: URL_ON_FLY, pending_update_count: 3, last_error_message: "Wrong response from the webhook: 401 Unauthorized", last_error_date: 1_700_000_000 }, true);
    expect(r.healthy).toBe(false);
    expect(r.findings.join(" ")).toMatch(/401 Unauthorized.*3 update/);
  });
  it("only the host of the address is reported, never the path", async () => {
    const t = fakeTelegram({ url: `${URL_ON_FLY}?x=1`, allowed_updates: ["message"] });
    const r = await getWebhookReport(ENV, t.fetchImpl);
    expect(JSON.stringify(r)).not.toContain("/api/telegram/webhook");
  });
});

describe("webhook repair", () => {
  it("re-registers the EXISTING address with all three update types, keeps the secret, drops nothing, and confirms", async () => {
    const t = fakeTelegram({ url: URL_ON_FLY, allowed_updates: ["message"], pending_update_count: 2 });
    const result = await repairWebhook(ENV, t.fetchImpl);
    const set = t.calls.find((c) => c.method === "setWebhook")!;
    expect(set.body).toEqual({
      url: URL_ON_FLY,
      allowed_updates: ["message", "edited_message", "callback_query"],
      secret_token: SECRET,
      drop_pending_updates: false,
    });
    expect(result.repaired).toBe(true);
    expect(result.before.missing).toEqual(["edited_message", "callback_query"]);
    expect(result.after.missing).toEqual([]);
    expect(result.after.healthy).toBe(true);
    // re-checked AFTER setWebhook
    expect(t.calls.map((c) => c.method)).toEqual(["getWebhookInfo", "getWebhookInfo", "setWebhook", "getWebhookInfo"]);
  });

  it("the token and the secret never appear in anything returned", async () => {
    const t = fakeTelegram({ url: URL_ON_FLY, allowed_updates: ["message"] });
    const result = await repairWebhook(ENV, t.fetchImpl);
    const out = JSON.stringify(result);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("AAExample");
  });

  it("refuses when there is no existing address - it never invents one", async () => {
    const t = fakeTelegram({ url: "" });
    const result = await repairWebhook(ENV, t.fetchImpl);
    expect(result.repaired).toBe(false);
    expect(t.calls.some((c) => c.method === "setWebhook")).toBe(false);
    expect(result.message).toMatch(/nothing was changed/);
  });

  it("refuses without a bot token and makes no Telegram call", async () => {
    const t = fakeTelegram({ url: URL_ON_FLY });
    const result = await repairWebhook({ botToken: null, webhookSecret: SECRET }, t.fetchImpl);
    expect(result.repaired).toBe(false);
    expect(t.calls).toHaveLength(0);
  });

  it("without a configured secret it does not send one", async () => {
    const t = fakeTelegram({ url: URL_ON_FLY, allowed_updates: ["message"] });
    await repairWebhook({ botToken: TOKEN, webhookSecret: null }, t.fetchImpl);
    expect(t.calls.find((c) => c.method === "setWebhook")!.body).not.toHaveProperty("secret_token");
  });
});

describe("errors never leak the token", () => {
  it("a network failure whose message carries the URL becomes a generic error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/getWebhookInfo`);
    }) as unknown as typeof fetch;
    const err = await getWebhookReport(ENV, fetchImpl).catch((e: Error) => e);
    expect((err as Error).message).toBe("Couldn't reach Telegram from the server.");
    expect((err as Error).message).not.toContain(TOKEN);
  });
  it("a Telegram refusal is relayed with any token-shaped text scrubbed", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: `Unauthorized for ${TOKEN}` }), { status: 401 })) as unknown as typeof fetch;
    const err = (await getWebhookReport(ENV, fetchImpl).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("Telegram refused getWebhookInfo");
    expect(err.message).not.toContain(TOKEN);
  });
  it("scrubToken only touches token-shaped text", () => {
    expect(scrubToken(`bad ${TOKEN} here`)).toBe("bad [token] here");
    expect(scrubToken("plain text 12:34")).toBe("plain text 12:34");
  });
});
