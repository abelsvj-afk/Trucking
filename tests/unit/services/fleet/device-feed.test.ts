import { describe, expect, it, vi } from "vitest";
import { bearerToken, hashDeviceToken, newDeviceToken, TOKEN_PREFIX } from "@/lib/device-token";
import { authenticateDeviceToken, feedBodySchema, MAX_FIX_AGE_MS, normalizeFixes, rateLimited } from "@/services/fleet/device-feed";

const NOW = Date.parse("2026-11-06T15:00:00Z");

describe("device tokens", () => {
  it("issues a prefixed random secret and stores only its hash", () => {
    const a = newDeviceToken();
    const b = newDeviceToken();
    expect(a.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashDeviceToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.token);
  });
  it("accepts only a well-formed Bearer tdv_ header", () => {
    const { token } = newDeviceToken();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    for (const bad of [null, "", token, `Basic ${token}`, "Bearer abc", `Bearer ${token}x y`, "Bearer tdv_short"]) expect(bearerToken(bad as string | null)).toBeNull();
  });
});

describe("feed body", () => {
  it("validates ranges and batch size", () => {
    const fix = { lat: 28, lng: -81, at: NOW };
    expect(feedBodySchema.safeParse({ fixes: [fix] }).success).toBe(true);
    expect(feedBodySchema.safeParse({ fixes: [] }).success).toBe(false);
    expect(feedBodySchema.safeParse({ fixes: Array(61).fill(fix) }).success).toBe(false);
    expect(feedBodySchema.safeParse({ fixes: [{ ...fix, lat: 91 }] }).success).toBe(false);
    expect(feedBodySchema.safeParse({ fixes: [{ ...fix, lng: -181 }] }).success).toBe(false);
    expect(feedBodySchema.safeParse({ nope: 1 }).success).toBe(false);
  });
  it("orders fixes by time and drops stale, future and unreadable-time fixes (counted, never trusted)", () => {
    const { usable, dropped } = normalizeFixes(
      [
        { lat: 1, lng: 1, at: NOW },
        { lat: 2, lng: 2, at: NOW - 60_000 },
        { lat: 3, lng: 3, at: NOW - MAX_FIX_AGE_MS - 1 },
        { lat: 4, lng: 4, at: NOW + 10 * 60_000 },
        { lat: 5, lng: 5, at: "not a time" },
        { lat: 6, lng: 6, at: new Date(NOW - 30_000).toISOString(), accuracy_m: 12, heading_deg: 90 },
      ],
      NOW,
    );
    expect(usable.map((u) => u.loc.latitude)).toEqual([2, 6, 1]);
    expect(dropped).toBe(3);
    expect(usable[1]!.loc).toMatchObject({ horizontal_accuracy: 12, heading: 90 });
  });
});

describe("authenticateDeviceToken", () => {
  function client(row: unknown, error: unknown = null) {
    const update = vi.fn(() => ({ eq: () => ({ eq: async () => ({}) }) }));
    const chain = { select: () => chain, eq: () => chain, is: () => chain, maybeSingle: async () => ({ data: row, error }), update };
    return { from: () => chain, update } as never;
  }
  it("returns the company for a live token; unknown or revoked (no row) is null", async () => {
    const { token } = newDeviceToken();
    expect(await authenticateDeviceToken(client({ id: "t1", company_id: "c1", last_used_at: new Date(NOW).toISOString() }), token, NOW)).toEqual({ tokenId: "t1", companyId: "c1" });
    expect(await authenticateDeviceToken(client(null), token, NOW)).toBeNull();
    expect(await authenticateDeviceToken(client(null, { message: "x" }), token, NOW)).toBeNull();
  });
});

describe("rate limit", () => {
  it("allows a normal batching rhythm and refuses a flood, per token", () => {
    const id = "tok-rate";
    for (let i = 0; i < 30; i++) expect(rateLimited(id, NOW + i)).toBe(false);
    expect(rateLimited(id, NOW + 31)).toBe(true);
    expect(rateLimited("other-token", NOW + 31)).toBe(false);
    expect(rateLimited(id, NOW + 61_000)).toBe(false); // the window moved on
  });
});
