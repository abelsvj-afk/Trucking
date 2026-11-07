// GET/POST /api/v1/telegram-webhook: owner session only; reports and repairs; never returns the token or the secret.

import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const TOKEN = "123456789:AAExampleExampleExampleExampleExample1";
const SECRET = "super-secret-header-value";

const auth = vi.fn();
vi.mock("@/services/auth", () => ({ getAuthContext: (...a: unknown[]) => auth(...a) }));

import { GET, POST } from "@/app/api/v1/telegram-webhook/route";

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function fakeTelegram() {
  const calls: string[] = [];
  let allowed: string[] = ["message"];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = String(input).split("/").pop()!;
    calls.push(method);
    if (method === "setWebhook") {
      allowed = (JSON.parse(String(init?.body)) as { allowed_updates: string[] }).allowed_updates;
      return new Response(JSON.stringify({ ok: true, result: true }));
    }
    return new Response(JSON.stringify({ ok: true, result: { url: "https://example-app.fly.dev/api/telegram/webhook", allowed_updates: allowed } }));
  }));
  return calls;
}

describe("/api/v1/telegram-webhook", () => {
  it("refuses an unauthenticated caller before touching Telegram", async () => {
    auth.mockResolvedValue(null);
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    const calls = fakeTelegram();
    const res = await POST(new NextRequest("http://localhost/api/v1/telegram-webhook", { method: "POST" }), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("GET reports, POST repairs and re-checks, and neither response carries the token or the secret", async () => {
    auth.mockResolvedValue({ userId: "u1", companyId: "c1", role: "owner" });
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const calls = fakeTelegram();
    const ctx = { params: Promise.resolve({}) } as never;

    const got = await GET(new NextRequest("http://localhost/api/v1/telegram-webhook"), ctx);
    const report = await got.json();
    expect(report.data.healthy).toBe(false);
    expect(report.data.missing).toEqual(["edited_message", "callback_query"]);

    const fixed = await POST(new NextRequest("http://localhost/api/v1/telegram-webhook", { method: "POST" }), ctx);
    const result = await fixed.json();
    expect(result.data.repaired).toBe(true);
    expect(result.data.after.healthy).toBe(true);
    expect(calls).toContain("setWebhook");

    const text = JSON.stringify([report, result]);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SECRET);
    expect(fixed.headers.get("Cache-Control")).toBe("no-store");
  });

  it("with no bot token on the server it says so and calls nothing", async () => {
    auth.mockResolvedValue({ userId: "u1", companyId: "c1", role: "owner" });
    delete process.env.TELEGRAM_BOT_TOKEN;
    const calls = fakeTelegram();
    const res = await GET(new NextRequest("http://localhost/api/v1/telegram-webhook"), { params: Promise.resolve({}) } as never);
    const body = await res.json();
    expect(body.data.configured).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
