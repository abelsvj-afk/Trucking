// Telegram webhook rate limit (owner decision D-10, 2026-11-05). The webhook
// is public to the internet; the secret token and the chat allowlist already
// bound who can be heard, and this bounds how fast. A sliding window per chat,
// in memory (one Fly machine; a restart forgives, which is fine for abuse
// control). Live Location fixes arrive every few seconds while he drives, so
// they get their own, higher budget instead of starving his messages.

export interface RateLimitConfig {
  max: number;
  windowMs: number;
}

export const MESSAGE_LIMIT: RateLimitConfig = { max: 40, windowMs: 60_000 };
export const LOCATION_LIMIT: RateLimitConfig = { max: 120, windowMs: 60_000 };

export type UpdateKind = "message" | "location";

export function createRateLimiter(limits: Record<UpdateKind, RateLimitConfig> = { message: MESSAGE_LIMIT, location: LOCATION_LIMIT }) {
  const hits = new Map<string, number[]>();
  return {
    /** True when this update is within budget (and counts it); false when it must be dropped. */
    allow(chatKey: string, kind: UpdateKind, nowMs: number): boolean {
      const { max, windowMs } = limits[kind];
      const key = `${kind}:${chatKey}`;
      const recent = (hits.get(key) ?? []).filter((t) => nowMs - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(nowMs);
      hits.set(key, recent);
      // Bound memory: forget idle keys opportunistically.
      if (hits.size > 500) for (const [k, v] of hits) if (v.length === 0 || nowMs - v[v.length - 1]! > windowMs) hits.delete(k);
      return true;
    },
  };
}
