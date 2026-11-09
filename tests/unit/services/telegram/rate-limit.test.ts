import { describe, expect, it } from "vitest";
import { createRateLimiter, MESSAGE_LIMIT } from "@/services/telegram/rate-limit";

describe("webhook rate limiter (D-10)", () => {
  const limits = { message: { max: 3, windowMs: 1000 }, location: { max: 5, windowMs: 1000 } };
  it("allows up to the budget then drops, and recovers as the window slides", () => {
    const rl = createRateLimiter(limits);
    expect([0, 1, 2, 3].map((t) => rl.allow("c1", "message", t))).toEqual([true, true, true, false]);
    expect(rl.allow("c1", "message", 1500)).toBe(true);
  });
  it("is per chat, and location fixes have their own budget so they cannot starve messages", () => {
    const rl = createRateLimiter(limits);
    for (let i = 0; i < 5; i++) expect(rl.allow("c1", "location", i)).toBe(true);
    expect(rl.allow("c1", "location", 6)).toBe(false);
    expect(rl.allow("c1", "message", 6)).toBe(true);
    expect(rl.allow("c2", "location", 6)).toBe(true);
  });
});

describe("default limits fit a full forwarded burst (T-005)", () => {
  it("the message budget is 60/min - a whole 50-item burst plus headroom", () => {
    expect(MESSAGE_LIMIT).toEqual({ max: 60, windowMs: 60_000 });
    const rl = createRateLimiter();
    // TELEGRAM_BURST_MAX_ITEMS is 50: every item of a max-size burst lands.
    for (let i = 0; i < 50; i++) expect(rl.allow("owner", "message", 1_000 + i)).toBe(true);
    // Headroom beyond the burst, then the cap bites.
    for (let i = 50; i < 60; i++) expect(rl.allow("owner", "message", 1_000 + i)).toBe(true);
    expect(rl.allow("owner", "message", 2_000)).toBe(false);
  });
});

describe("allowWithNotice (T-005 drop notification)", () => {
  it("the first drop notifies once, later drops stay quiet inside the 10-minute window", () => {
    const rl = createRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 60; i++) expect(rl.allowWithNotice("owner", "message", t0 + i)).toEqual({ allowed: true, notify: false });
    // The 61st message in the minute is dropped, with the one notice.
    expect(rl.allowWithNotice("owner", "message", t0 + 60)).toEqual({ allowed: false, notify: true });
    // Subsequent drops within 10 minutes do not notify again.
    expect(rl.allowWithNotice("owner", "message", t0 + 61)).toEqual({ allowed: false, notify: false });
    // Five minutes later the sliding minute has forgiven the first burst; fill the
    // budget again - the drop is real, but the notice is still throttled (< 10 min).
    const t1 = t0 + 5 * 60_000;
    for (let i = 0; i < 60; i++) expect(rl.allow("owner", "message", t1 + i)).toBe(true);
    expect(rl.allowWithNotice("owner", "message", t1 + 60)).toEqual({ allowed: false, notify: false });
  });

  it("notifies again once the 10-minute quiet window has passed and the budget is full again", () => {
    const rl = createRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 60; i++) rl.allow("owner", "message", t0 + i);
    expect(rl.allowWithNotice("owner", "message", t0 + 60)).toEqual({ allowed: false, notify: true });
    // 10 minutes later the sliding window has forgiven the burst; fill it again and the next drop notifies.
    const t1 = t0 + 10 * 60_000 + 1;
    for (let i = 0; i < 60; i++) expect(rl.allow("owner", "message", t1 + i)).toBe(true);
    expect(rl.allowWithNotice("owner", "message", t1 + 60)).toEqual({ allowed: false, notify: true });
  });

  it("the notice throttle is per chat and per kind", () => {
    const rl = createRateLimiter({ message: { max: 1, windowMs: 60_000 }, location: { max: 1, windowMs: 60_000 } });
    expect(rl.allowWithNotice("c1", "message", 0)).toEqual({ allowed: true, notify: false });
    expect(rl.allowWithNotice("c1", "message", 1)).toEqual({ allowed: false, notify: true });
    // A different chat, and a different kind for the same chat, each get their own first notice.
    expect(rl.allowWithNotice("c2", "message", 2)).toEqual({ allowed: true, notify: false });
    expect(rl.allowWithNotice("c2", "message", 3)).toEqual({ allowed: false, notify: true });
    expect(rl.allowWithNotice("c1", "location", 4)).toEqual({ allowed: true, notify: false });
    expect(rl.allowWithNotice("c1", "location", 5)).toEqual({ allowed: false, notify: true });
  });
});
