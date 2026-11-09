import { describe, expect, it } from "vitest";

// The Tracker overlay's clock rules (native/tracker/www/overlay-clocks.js): plain JS, tested here.
// The module only FORMATS the server's clocks - every assertion below is about refusing to invent:
// a malformed or partial answer yields null (the overlay hides), never made-up numbers.

// @ts-expect-error -- plain JS module (native/tracker/www) with no declaration file
const load = async () => (await import("../../../native/tracker/www/overlay-clocks.js")) as unknown as {
  clocksUrl: (s: string) => string;
  formatRemaining: (ms: number) => string;
  overlayPayload: (json: unknown, nowMs: number) => { state: string; statusText: string; lines: { label: string; text: string; tone: string; remainingMs: number }[] } | null;
};

const READY = {
  data: {
    state: "ready",
    status: "driving",
    computedAt: "2026-11-09T15:00:00.000Z",
    clocks: [
      { key: "drive", label: "Drive", remainingMs: 8 * 3_600_000, totalMs: 11 * 3_600_000, tone: "ok" },
      { key: "window", label: "14-hour window", remainingMs: 10 * 3_600_000, totalMs: 14 * 3_600_000, tone: "ok" },
      { key: "break", label: "Break due in", remainingMs: 5 * 3_600_000, totalMs: 8 * 3_600_000, tone: "ok" },
      { key: "cycle", label: "70/8 cycle", remainingMs: 60 * 3_600_000, totalMs: 70 * 3_600_000, tone: "ok" },
    ],
  },
};

describe("overlay-clocks", () => {
  it("builds the clocks URL from the saved server, with or without a trailing slash", async () => {
    const { clocksUrl } = await load();
    expect(clocksUrl("https://trucking.fly.dev")).toBe("https://trucking.fly.dev/api/v1/position/clocks");
    expect(clocksUrl("https://trucking.fly.dev/")).toBe("https://trucking.fly.dev/api/v1/position/clocks");
  });

  it("formats remaining time as H:MM and never negative", async () => {
    const { formatRemaining } = await load();
    expect(formatRemaining(8 * 3_600_000 + 5 * 60_000)).toBe("8:05");
    expect(formatRemaining(0)).toBe("0:00");
    expect(formatRemaining(-5)).toBe("0:00");
  });

  it("shapes a ready answer into the four card lines in drive/window/break/cycle order", async () => {
    const { overlayPayload } = await load();
    const p = overlayPayload(READY, 0)!;
    expect(p.statusText).toBe("Driving");
    expect(p.lines.map((l) => l.label)).toEqual(["DRIVE", "WINDOW", "BREAK", "70-HR"]);
    expect(p.lines.map((l) => l.text)).toEqual(["8:00", "10:00", "5:00", "60:00"]);
    expect(p.lines[0]!.remainingMs).toBe(8 * 3_600_000);
  });

  it("marks an exhausted clock expired", async () => {
    const { overlayPayload } = await load();
    const drained = structuredClone(READY);
    drained.data.clocks[0]!.remainingMs = 0;
    const p = overlayPayload(drained, 0)!;
    expect(p.lines[0]!.tone).toBe("expired");
  });

  it("passes the no-logs state through as an honest empty card", async () => {
    const { overlayPayload } = await load();
    const p = overlayPayload({ data: { state: "no-logs", computedAt: "2026-11-09T15:00:00.000Z", clocks: [] } }, 0)!;
    expect(p.state).toBe("no-logs");
    expect(p.lines).toEqual([]);
  });

  it("returns null - hide, never invent - for malformed or partial answers", async () => {
    const { overlayPayload } = await load();
    expect(overlayPayload(null, 0)).toBeNull();
    expect(overlayPayload({}, 0)).toBeNull();
    expect(overlayPayload({ data: { state: "ready", clocks: "nope" } }, 0)).toBeNull();
    const partial = structuredClone(READY);
    partial.data.clocks = partial.data.clocks.slice(0, 3); // cycle missing
    expect(overlayPayload(partial, 0)).toBeNull();
    const badValue = structuredClone(READY);
    (badValue.data.clocks[1] as { remainingMs: unknown }).remainingMs = "ten hours";
    expect(overlayPayload(badValue, 0)).toBeNull();
  });
});
