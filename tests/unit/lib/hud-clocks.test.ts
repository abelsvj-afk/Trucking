import { describe, expect, it } from "vitest";
import { computeHudClocks, formatClock, toneFor, TONE_WORDS, type HudDutyRow } from "@/lib/hud-clocks";
import type { DutyLogWindowSummary } from "@/types/hos-settings";

const T0 = Date.parse("2026-11-04T06:00:00Z");
const H = 3_600_000;
const M = 60_000;
const at = (ms: number) => new Date(ms).toISOString();
const row = (duty_status: HudDutyRow["duty_status"], ms: number): HudDutyRow => ({
  duty_status,
  started_at: at(ms),
});

function cycleSummary(onDutyMinutes: number, windowEndMs: number): DutyLogWindowSummary {
  return {
    cycle: "70/8",
    cycleLimitMinutes: 4200,
    periodAnchor: "00:00",
    restartEnabled: true,
    carrierTimeZone: "America/New_York",
    windowStart: at(windowEndMs - 8 * 24 * H),
    windowEnd: at(windowEndMs),
    currentPeriodStart: at(windowEndMs - 6 * H),
    onDutyMinutesInCycle: onDutyMinutes,
    restartApplied: null,
    restartUnverified: false,
    warnings: [],
  };
}

function ready(r: ReturnType<typeof computeHudClocks>) {
  if (r.state !== "ready") throw new Error("expected ready");
  return r;
}
const by = (r: ReturnType<typeof ready>, key: string) => r.clocks.find((c) => c.key === key)!;

describe("computeHudClocks", () => {
  it("says no-logs instead of inventing a running clock", () => {
    expect(computeHudClocks([], null, T0).state).toBe("no-logs");
  });

  it("ignores rows that start in the future", () => {
    expect(computeHudClocks([row("driving", T0 + H)], null, T0).state).toBe("no-logs");
  });

  it("counts drive and window from the start of the duty period, to the second", () => {
    // off duty 12h, on duty 1h, driving 2h30m (still driving)
    const start = T0 - 12 * H;
    const rows = [row("off_duty", start - 12 * H), row("on_duty", start), row("driving", start + H)];
    const now = start + H + 2.5 * H + 7000;
    const r = ready(computeHudClocks(rows, null, now));
    expect(r.status).toBe("driving");
    expect(by(r, "drive").remainingMs).toBe(11 * H - (2.5 * H + 7000));
    expect(by(r, "window").remainingMs).toBe(14 * H - (3.5 * H + 7000));
    expect(by(r, "break").remainingMs).toBe(8 * H - (2.5 * H + 7000));
  });

  it("is monotonic: one second later the driving clocks are exactly one second lower", () => {
    const rows = [row("off_duty", T0 - 20 * H), row("driving", T0 - 2 * H)];
    const a = ready(computeHudClocks(rows, null, T0));
    const b = ready(computeHudClocks(rows, null, T0 + 1000));
    expect(by(a, "drive").remainingMs - by(b, "drive").remainingMs).toBe(1000);
    expect(by(a, "window").remainingMs - by(b, "window").remainingMs).toBe(1000);
  });

  it("a 30-minute non-driving break resets the break clock but not drive time", () => {
    const s = T0 - 10 * H;
    const rows = [
      row("off_duty", s - 11 * H),
      row("driving", s),
      row("on_duty", s + 4 * H),
      row("driving", s + 4.5 * H),
    ];
    const r = ready(computeHudClocks(rows, null, s + 6 * H));
    expect(by(r, "drive").remainingMs).toBe(11 * H - 5.5 * H);
    expect(by(r, "break").remainingMs).toBe(8 * H - 1.5 * H);
  });

  it("a 10-hour rest starts a fresh window: full drive/window, flagged rested", () => {
    const rows = [row("driving", T0 - 30 * H), row("off_duty", T0 - 20 * H)];
    const r = ready(computeHudClocks(rows, null, T0));
    expect(r.rested).toBe(true);
    expect(by(r, "drive").remainingMs).toBe(11 * H);
    expect(by(r, "window").remainingMs).toBe(14 * H);
  });

  it("a short rest is not 'rested' and the window keeps running", () => {
    const rows = [row("driving", T0 - 9 * H), row("sleeper", T0 - 2 * H)];
    const r = ready(computeHudClocks(rows, null, T0));
    expect(r.rested).toBe(false);
    expect(by(r, "window").remainingMs).toBe(14 * H - 9 * H);
  });

  it("clamps at zero and marks expired instead of going negative", () => {
    const rows = [row("off_duty", T0 - 40 * H), row("driving", T0 - 15 * H)];
    const r = ready(computeHudClocks(rows, null, T0));
    expect(by(r, "drive").remainingMs).toBe(0);
    expect(by(r, "drive").tone).toBe("expired");
    expect(by(r, "window").remainingMs).toBe(0);
  });

  describe("cycle", () => {
    it("is unavailable - not guessed - without the server's carrier-anchored summary", () => {
      const r = ready(computeHudClocks([row("driving", T0 - H)], null, T0));
      expect(r.cycleUnavailable).toBe(true);
      expect(r.clocks.some((c) => c.key === "cycle")).toBe(false);
    });

    it("adds on-duty time elapsed since the fetch while driving", () => {
      const fetchedAt = T0;
      const rows = [row("off_duty", T0 - 20 * H), row("driving", T0 - H)];
      const r = ready(computeHudClocks(rows, cycleSummary(60 * 40, fetchedAt), fetchedAt + 10 * M));
      expect(by(r, "cycle").remainingMs).toBe(4200 * M - (60 * 40 * M + 10 * M));
    });

    it("does not add elapsed time while off duty", () => {
      const rows = [row("driving", T0 - 5 * H), row("off_duty", T0 - H)];
      const r = ready(computeHudClocks(rows, cycleSummary(60 * 40, T0), T0 + 30 * M));
      expect(by(r, "cycle").remainingMs).toBe(4200 * M - 60 * 40 * M);
    });
  });
});

describe("toneFor / formatClock", () => {
  it("shifts colour as limits approach", () => {
    expect(toneFor(5 * H)).toBe("ok");
    expect(toneFor(121 * M)).toBe("ok");
    expect(toneFor(2 * H)).toBe("warn"); // amber at <= 2 h
    expect(toneFor(61 * M)).toBe("warn");
    expect(toneFor(30 * M)).toBe("critical");
    expect(toneFor(31 * M)).toBe("warn");
    expect(toneFor(0)).toBe("expired");
  });
  it("tones are also words (never colour alone), and the expired word is unmistakable", () => {
    expect(TONE_WORDS.warn).toBe("Under 2 hours");
    expect(TONE_WORDS.critical).toBe("Under 30 minutes");
    expect(TONE_WORDS.expired).toBe("EXPIRED");
    expect(TONE_WORDS.ok).toBe("");
  });
  it("formats H:MM:SS and never negative", () => {
    expect(formatClock(3 * H + 5 * M + 9000)).toBe("3:05:09");
    expect(formatClock(-5)).toBe("0:00:00");
  });
});
