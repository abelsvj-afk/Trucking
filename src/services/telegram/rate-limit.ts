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

// 60/min, not 40: a forwarded conversation burst can carry up to
// TELEGRAM_BURST_MAX_ITEMS (50, services/telegram/burst.ts) updates in well
// under a minute, and the old 40/min cap silently dropped the tail of a full
// burst. 60 fits one whole burst plus headroom for ordinary messages.
export const MESSAGE_LIMIT: RateLimitConfig = { max: 60, windowMs: 60_000 };
export const LOCATION_LIMIT: RateLimitConfig = { max: 120, windowMs: 60_000 };

export type UpdateKind = "message" | "location";

/** After a drop notice goes out for a chat+kind, stay quiet this long - the notice itself must not spam. */
export const DROP_NOTICE_INTERVAL_MS = 10 * 60_000;

export interface AllowWithNoticeResult {
  allowed: boolean;
  /** True at most once per DROP_NOTICE_INTERVAL_MS per chat+kind, and only on a drop. */
  notify: boolean;
}

export function createRateLimiter(limits: Record<UpdateKind, RateLimitConfig> = { message: MESSAGE_LIMIT, location: LOCATION_LIMIT }) {
  const hits = new Map<string, number[]>();
  const lastNotified = new Map<string, number>();

  /** True when this update is within budget (and counts it); false when it must be dropped. */
  function allow(chatKey: string, kind: UpdateKind, nowMs: number): boolean {
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
  }

  /**
   * Like allow(), but a drop also says whether the owner should be told: notify is true at most
   * once per DROP_NOTICE_INTERVAL_MS per chat+kind, so a flood produces one notice, not fifty.
   */
  function allowWithNotice(chatKey: string, kind: UpdateKind, nowMs: number): AllowWithNoticeResult {
    if (allow(chatKey, kind, nowMs)) return { allowed: true, notify: false };
    const key = `${kind}:${chatKey}`;
    const last = lastNotified.get(key);
    if (last !== undefined && nowMs - last < DROP_NOTICE_INTERVAL_MS) return { allowed: false, notify: false };
    lastNotified.set(key, nowMs);
    return { allowed: false, notify: true };
  }

  return { allow, allowWithNotice };
}
