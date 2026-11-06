import { describe, expect, it } from "vitest";
import { activeLocks, resetLine } from "@/lib/clock-locks";
import { formatClock, type HudClock } from "@/lib/hud-clocks";

const H = 3_600_000;
const clock = (key: HudClock["key"], tone: HudClock["tone"], reset?: HudClock["reset"]): HudClock => ({ key, label: key, remainingMs: tone === "expired" ? 0 : H, totalMs: 11 * H, tone, reset });

describe("what an expired clock locks", () => {
  it("lists a lock for each EXPIRED clock only, saying what is locked, why, and what is still allowed", () => {
    const locks = activeLocks([clock("drive", "expired"), clock("window", "warn"), clock("break", "expired"), clock("cycle", "ok")]);
    expect(locks.map((l) => l.key)).toEqual(["drive", "break"]);
    for (const l of locks) {
      expect(l.locked).toBe("Driving");
      expect(l.why.length).toBeGreaterThan(10);
      expect(l.stillAllowed.length).toBeGreaterThan(10);
    }
  });
  it("nothing is locked while no clock is expired", () => {
    expect(activeLocks([clock("drive", "critical"), clock("window", "ok")])).toEqual([]);
  });
  it("the reset line counts down while resting and says when it starts otherwise", () => {
    const resting = clock("drive", "expired", { requiredMs: 10 * H, progressMs: H, remainingMs: 9 * H, underway: true, how: "10 straight hours off duty or in the sleeper berth" });
    expect(resetLine(resting, formatClock)).toBe("Resets in 9:00:00 (10 straight hours off duty or in the sleeper berth).");
    const waiting = clock("drive", "expired", { requiredMs: 10 * H, progressMs: 0, remainingMs: 10 * H, underway: false, how: "10 straight hours off" });
    expect(resetLine(waiting, formatClock)).toContain("Reset starts when you stop: needs 10:00:00");
  });
  it("an expired cycle with no restart rule says there is no timed reset (never a made-up countdown)", () => {
    expect(resetLine(clock("cycle", "expired"), formatClock)).toContain("No timed reset");
    expect(resetLine(clock("drive", "ok"), formatClock)).toBeNull();
  });
});
