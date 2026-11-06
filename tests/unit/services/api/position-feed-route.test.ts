import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const handleLiveLocation = vi.fn(async () => ({ kind: "recorded", proposed: null }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }));
vi.mock("@/services/telegram/live-location", () => ({ handleLiveLocation: (...a: unknown[]) => (handleLiveLocation as (...x: unknown[]) => unknown)(...a), createBrainLiveLocationStore: () => ({}) }));
vi.mock("@/services/telegram/notify", () => ({ createTelegramNotifier: () => ({ notifyOwner: async () => true }) }));
const brain = { isLiveLocationEnabled: vi.fn(async () => true) };
vi.mock("@/services/telegram/store", () => ({ createTelegramBrainStore: () => brain }));
const auth = vi.fn();
vi.mock("@/services/fleet/device-feed", async () => {
  const actual = await vi.importActual<typeof import("@/services/fleet/device-feed")>("@/services/fleet/device-feed");
  return { ...actual, authenticateDeviceToken: (...a: unknown[]) => auth(...a) };
});

import { POST } from "@/app/api/v1/position/feed/route";
import { newDeviceToken } from "@/lib/device-token";

const NOW = Date.now();
const req = (headers: Record<string, string>, body: unknown) =>
  new NextRequest("http://localhost/api/v1/position/feed", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://x";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
  handleLiveLocation.mockClear();
  auth.mockReset();
  brain.isLiveLocationEnabled.mockResolvedValue(true);
});

describe("POST /api/v1/position/feed", () => {
  const goodBody = { fixes: [{ lat: 28, lng: -81, at: NOW - 1000 }] };
  it("401 with no/odd credentials - one generic body, nothing touched", async () => {
    for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: "Basic abc" }] as Record<string, string>[]) {
      const res = await POST(req(headers, goodBody));
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("UNAUTHORIZED");
    }
    expect(auth).not.toHaveBeenCalled();
  });
  it("401 for an unknown or revoked token", async () => {
    auth.mockResolvedValue(null);
    expect((await POST(req({ authorization: `Bearer ${newDeviceToken().token}` }, goodBody))).status).toBe(401);
    expect(handleLiveLocation).not.toHaveBeenCalled();
  });
  it("400 on a bad body", async () => {
    auth.mockResolvedValue({ tokenId: "t-bad-body", companyId: "c1" });
    const h = { authorization: `Bearer ${newDeviceToken().token}` };
    expect((await POST(req(h, "not json"))).status).toBe(400);
    expect((await POST(req(h, { fixes: [] }))).status).toBe(400);
    expect((await POST(req(h, { fixes: [{ lat: 99, lng: 0, at: NOW }] }))).status).toBe(400);
  });
  it("runs each usable fix through the shared detection, scoped to the token's company, and counts them", async () => {
    auth.mockResolvedValue({ tokenId: "t-ok", companyId: "c1" });
    const res = await POST(req({ authorization: `Bearer ${newDeviceToken().token}` }, { fixes: [{ lat: 28, lng: -81, at: NOW - 2000 }, { lat: 28.001, lng: -81, at: NOW - 1000 }, { lat: 28, lng: -81, at: "garbage" }] }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ accepted: 2, dropped: 1 });
    expect(handleLiveLocation).toHaveBeenCalledTimes(2);
  });
  it("respects the live_location switch", async () => {
    auth.mockResolvedValue({ tokenId: "t-off", companyId: "c1" });
    brain.isLiveLocationEnabled.mockResolvedValue(false);
    const res = await POST(req({ authorization: `Bearer ${newDeviceToken().token}` }, goodBody));
    expect((await res.json()).data.reason).toBe("switched_off");
    expect(handleLiveLocation).not.toHaveBeenCalled();
  });
  it("429 when a token floods", async () => {
    auth.mockResolvedValue({ tokenId: "t-flood", companyId: "c1" });
    const h = { authorization: `Bearer ${newDeviceToken().token}` };
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await POST(req(h, goodBody))).status;
    expect(last).toBe(429);
  });
});
