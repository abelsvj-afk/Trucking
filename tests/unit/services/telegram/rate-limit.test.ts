import { describe, expect, it } from "vitest";
import { createRateLimiter } from "@/services/telegram/rate-limit";

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
