// Owner 2026-11-17: "Smart Path shouldn't wait on me, and Abel should use it".
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeResult } from "../../fixtures/route-check-fixture";
import type { AutoRunResult } from "@/services/smart-path/auto";

const run = vi.fn<() => Promise<AutoRunResult>>();
vi.mock("@/services/smart-path/auto", () => ({ runAutoSmartPath: () => run() }));

import { planSmartPathWatch, resetSmartPathWatch, watchAlert } from "@/services/bot/smart-path-watch";
import type { BotBrainStore } from "@/services/bot/store";

const out = (status: "on_time" | "late" | "not_legal", clocks?: Parameters<typeof makeResult>[0]): AutoRunResult => {
  const r = makeResult(clocks);
  r.verdict.status = status;
  r.verdict.tradeoffLines = [status === "late" ? "You'd arrive 3h after the window closes." : "You make it with 2h to spare."];
  return { phase: "loaded", assumptions: [], load: { id: "L1", label: "Trip 9918: A → B", status: "confirmed" }, choices: [], result: r };
};
const store = { client: {}, companyId: "c" } as unknown as BotBrainStore;
const NOW = new Date("2026-11-17T15:00:00Z");

beforeEach(() => {
  resetSmartPathWatch();
  run.mockReset();
});

describe("Smart Path watch", () => {
  it("LATE is said once per load, with why, the hours used, and the link", () => {
    const a = watchAlert(out("late", { clocks: { driveLeftMin: 300, windowLeftMin: 500, breakLeftMin: 480, weekLeftMin: 0, fromLogs: true }, clocksSource: "app_log" }), "https://app.example.test")!;
    expect(a.key).toBe("smartpath:L1:late");
    expect(a.critical).toBe(false);
    expect(a.text).toContain("is now LATE");
    expect(a.text).toContain("3h after the window closes");
    expect(a.text).toContain("this app's duty log");
    expect(a.text).toContain("tell me what you actually did");
    expect(a.text).toContain("https://app.example.test/smart-path");
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
    expect(watchAlert({ phase: "no_load", assumptions: [], load: null, choices: [], result: null }, null)).toBeNull();
  });
});
