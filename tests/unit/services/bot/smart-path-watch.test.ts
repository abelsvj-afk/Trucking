// Owner 2026-11-17: "Smart Path shouldn't wait on me, and Abel should use it".
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeResult } from "../../fixtures/route-check-fixture";
import type { AutoRunResult } from "@/services/smart-path/auto";

const run = vi.fn<() => Promise<AutoRunResult>>();
vi.mock("@/services/smart-path/auto", () => ({ runAutoSmartPath: () => run() }));

import { planSmartPathWatch, resetSmartPathWatch, watchAlert } from "@/services/bot/smart-path-watch";
import type { BotBrainStore } from "@/services/bot/store";

const out = (
  status: "on_time" | "late" | "not_legal",
  clocks?: Parameters<typeof makeResult>[0],
  runOver: Partial<AutoRunResult> = {},
): AutoRunResult => {
  const r = makeResult(clocks);
  r.verdict.status = status;
  r.verdict.tradeoffLines = [status === "late" ? "You'd arrive 3h after the window closes." : "You make it with 2h to spare."];
  return {
    phase: "loaded",
    assumptions: [],
    load: { id: "L1", label: "Trip 9918: A → B", status: "confirmed" },
    choices: [],
    result: r,
    positionAgeSeconds: 120,
    pickupUnconfirmed: false,
    pickupUnknownBasis: null,
    deliveryWindowEstimated: false,
    ...runOver,
  };
};
const store = { client: {}, companyId: "c" } as unknown as BotBrainStore;
const NOW = new Date("2026-11-17T15:00:00Z");

beforeEach(() => {
  resetSmartPathWatch();
  run.mockReset();
});

describe("Smart Path watch", () => {
  it("LATE is said once per load, with why, the hours used, and the link — when the inputs are solid", () => {
    const a = watchAlert(out("late"), "https://app.example.test")!;
    expect(a.key).toBe("smartpath:L1:late");
    expect(a.critical).toBe(false);
    expect(a.text).toContain("is now LATE");
    expect(a.text).toContain("3h after the window closes");
    expect(a.text).toContain("this app's duty log");
    expect(a.text).toContain("https://app.example.test/smart-path");
  });

  it("Fix B: a LATE verdict on a used-up app log is UNCERTAIN, not LATE — it names the log (the owner's 2026-11-17 case)", () => {
    const a = watchAlert(out("late", { clocks: { driveLeftMin: 300, windowLeftMin: 500, breakLeftMin: 480, weekLeftMin: 0, fromLogs: true }, clocksSource: "app_log" }), "https://app.example.test")!;
    expect(a.key).toBe("smartpath:L1:uncertain");
    expect(a.text).not.toContain("is now LATE");
    expect(a.text).toContain("can't call this late yet");
    expect(a.text).toContain("your hours log says you're nearly out of driving or shift time");
    expect(a.text).toContain("3h after the window closes");
    // A separate dedupe key: the real LATE alert can still fire once the log is fixed.
    expect(a.key).not.toBe("smartpath:L1:late");
  });

  it("Fix B: ELD-entered hours are trusted — a tight ELD clock still declares LATE", () => {
    const a = watchAlert(out("late", { clocks: { driveLeftMin: 300, windowLeftMin: 500, breakLeftMin: 480, weekLeftMin: 0, fromLogs: false }, clocksSource: "eld_entered" }), null)!;
    expect(a.key).toBe("smartpath:L1:late");
    expect(a.text).toContain("is now LATE");
  });

  it("Fix B: a stale position (over an hour old) makes the verdict uncertain and names the position", () => {
    const a = watchAlert(out("late", undefined, { positionAgeSeconds: 3 * 3600 }), null)!;
    expect(a.key).toBe("smartpath:L1:uncertain");
    expect(a.text).not.toContain("is now LATE");
    expect(a.text).toContain("your last position is 3 h ago old");
  });

  it("Fix B: no live position at all makes the verdict uncertain", () => {
    const a = watchAlert(out("late", undefined, { phase: "no_position", positionAgeSeconds: null }), null)!;
    expect(a.key).toBe("smartpath:L1:uncertain");
    expect(a.text).toContain("no live position from this phone or the Tracker");
  });

  it("Fix B + C: an unconfirmed pickup makes the verdict uncertain AND the why line carries the trip-state basis", () => {
    const basis = "The pickup was never marked left — the truck is 40 mi from the pickup and the pickup window has ended, so I'm aiming at the delivery instead. Tap 'I left' on the pickup to confirm.";
    const a = watchAlert(out("late", undefined, { pickupUnconfirmed: true, pickupUnknownBasis: basis }), null)!;
    expect(a.key).toBe("smartpath:L1:uncertain");
    expect(a.text).not.toContain("is now LATE");
    expect(a.text).toContain("can't confirm you left the pickup yet");
    expect(a.text).toContain(basis);
  });

  it("Fix B: no 'back on time' on shaky inputs — a recovery declared on a guess is as wrong as a late call", async () => {
    run.mockResolvedValue(out("on_time", { clocks: { driveLeftMin: 300, windowLeftMin: 500, breakLeftMin: 480, weekLeftMin: 0, fromLogs: true }, clocksSource: "app_log" }));
    expect(await planSmartPathWatch(store, NOW, async () => true, null)).toBeNull();
  });

  it("'back on time' only after a warning for that load", async () => {
    run.mockResolvedValue(out("on_time"));
    expect(await planSmartPathWatch(store, NOW, async () => false, null)).toBeNull();
    resetSmartPathWatch();
    const back = await planSmartPathWatch(store, NOW, async () => true, null);
    expect(back?.key).toBe("smartpath:L1:ok");
    expect(back?.text).toContain("is back ON TIME");
  });

  it("runs at most once an hour", async () => {
    run.mockResolvedValue(out("late"));
    expect(await planSmartPathWatch(store, NOW, async () => false, null)).not.toBeNull();
    expect(await planSmartPathWatch(store, new Date(NOW.getTime() + 30 * 60_000), async () => false, null)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    await planSmartPathWatch(store, new Date(NOW.getTime() + 61 * 60_000), async () => false, null);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("no load or no plan: nothing to say", () => {
    expect(watchAlert({ phase: "no_load", assumptions: [], load: null, choices: [], result: null, positionAgeSeconds: null, pickupUnconfirmed: false, pickupUnknownBasis: null, deliveryWindowEstimated: false }, null)).toBeNull();
  });
});
