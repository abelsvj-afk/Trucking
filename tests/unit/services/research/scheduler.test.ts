import { describe, expect, it, vi } from "vitest";

// CD-7: when INDUSTRY_BRIEFING_DB_URL is unset, getIndustryBriefingPool
// throws at construction. The tick used to swallow that in a console-only
// catch - no heartbeat, no watchdog, and the internal endpoint answered
// 200 with health: null. The tick must instead surface an explicit
// health failure and still fire the config-missing alert (throttled).
const notifyOwner = vi.fn(async (_text: string) => true);

vi.mock("@/services/db/industry-briefing-pool", () => ({
  getIndustryBriefingPool: () => {
    throw new Error("INDUSTRY_BRIEFING_DB_URL is not configured.");
  },
}));

vi.mock("@/services/telegram/notify", () => ({
  createTelegramNotifier: () => ({ notifyOwner }),
}));

import { runResearchTick } from "@/services/research/scheduler";

describe("runResearchTick when the job database is not configured (CD-7)", () => {
  it("surfaces an explicit health failure instead of health: null, and alerts the owner", async () => {
    const summary = await runResearchTick("endpoint");

    expect(summary.health).not.toBeNull();
    expect(summary.health?.failure).toContain("INDUSTRY_BRIEFING_DB_URL");
    expect(summary.health?.alertsSent).toContain("runner_config_missing");
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(String(notifyOwner.mock.calls[0]?.[0])).toContain("INDUSTRY_BRIEFING_DB_URL");
  });

  it("throttles the config-missing alert - a second broken tick does not re-alert", async () => {
    const summary = await runResearchTick("endpoint");

    expect(summary.health?.failure).toContain("INDUSTRY_BRIEFING_DB_URL");
    expect(notifyOwner).toHaveBeenCalledTimes(1); // still one - throttled at 24h
  });
});
