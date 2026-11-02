import { describe, expect, it } from "vitest";
import { getResearchConfig } from "@/services/research/config";
import {
  classifyDelivery,
  deliveryDecision,
  etHour,
  formatBriefingMessage,
  formatDigestMessage,
  isQuietHours,
} from "@/services/research/delivery";
import type { PressureSignal } from "@/services/research/watchers/types";

const config = getResearchConfig({} as NodeJS.ProcessEnv);

function signal(partial: Partial<PressureSignal>): PressureSignal {
  return {
    watcherKey: "industry_news",
    kind: "news_burst",
    topic: "fuel",
    magnitude: 0.5,
    summary: "s",
    items: [],
    data: {},
    dedupeKey: "k",
    observedAt: "2026-10-31T12:00:00Z",
    ...partial,
  };
}

// 2026-10-31 is EDT (UTC-4) until Nov 1. 02:30Z = 22:30 ET (quiet);
// 15:00Z = 11:00 ET (daytime); 10:30Z = 06:30 ET (morning, awake).
const NIGHT_ET = new Date("2026-10-31T02:30:00Z");
const DAY_ET = new Date("2026-10-31T15:00:00Z");
const MORNING_ET = new Date("2026-10-31T10:30:00Z");

describe("Eastern-time helpers", () => {
  it("reads the ET hour regardless of the host timezone", () => {
    expect(etHour(NIGHT_ET)).toBe(22);
    expect(etHour(DAY_ET)).toBe(11);
    expect(etHour(MORNING_ET)).toBe(6);
  });

  it("quiet hours are 21:00-06:00 ET", () => {
    expect(isQuietHours(NIGHT_ET, config)).toBe(true);
    expect(isQuietHours(DAY_ET, config)).toBe(false);
    expect(isQuietHours(MORNING_ET, config)).toBe(false);
  });
});

describe("classifyDelivery", () => {
  it("urgent: warning-class weather, top-magnitude final law, diesel spike >= 6%", () => {
    expect(
      classifyDelivery({ signals: [signal({ watcherKey: "nws_weather", kind: "weather_alert", topic: "weather", data: { severityRank: 5 } })] }),
    ).toBe("urgent");
    expect(
      classifyDelivery({ signals: [signal({ watcherKey: "federal_register", kind: "federal_rule_final", topic: "regulation", magnitude: 0.95 })] }),
    ).toBe("urgent");
    expect(
      classifyDelivery({ signals: [signal({ watcherKey: "eia_diesel", kind: "fuel_price_observation", data: { wowPct: -6.5 } })] }),
    ).toBe("urgent");
  });

  it("trip: a producing signal touches his corridor states", () => {
    expect(
      classifyDelivery({
        signals: [signal({ watcherKey: "openstates", kind: "state_law_introduced", topic: "regulation", data: { states: ["FL"] } })],
        corridorStates: ["FL", "GA"],
      }),
    ).toBe("trip");
  });

  it("routine: everything else", () => {
    expect(classifyDelivery({ signals: [signal({})] })).toBe("routine");
    expect(
      classifyDelivery({
        signals: [signal({ watcherKey: "openstates", kind: "state_law_introduced", topic: "regulation", data: { states: ["TX"] } })],
        corridorStates: ["FL"],
      }),
    ).toBe("routine");
  });
});

describe("deliveryDecision", () => {
  it("urgent always sends now - even at night, even while driving", () => {
    expect(
      deliveryDecision({ now: NIGHT_ET, deliveryClass: "urgent", latestDutyStatus: "driving", config }),
    ).toEqual({ sendNow: true, heldUntil: null, reason: null });
  });

  it("routine holds during quiet hours until 06:00 ET", () => {
    const decision = deliveryDecision({ now: NIGHT_ET, deliveryClass: "routine", latestDutyStatus: "off_duty", config });
    expect(decision.sendNow).toBe(false);
    expect(decision.heldUntil?.toISOString()).toBe("2026-10-31T10:00:00.000Z"); // 06:00 EDT
    expect(decision.reason).toMatch(/quiet hours/);
  });

  it("names the default quiet window in the hold reason", () => {
    const decision = deliveryDecision({ now: NIGHT_ET, deliveryClass: "routine", latestDutyStatus: "off_duty", config });
    expect(decision.reason).toContain("quiet hours (21:00-06:00 ET)");
  });

  it("formats the quiet-hours reason from the CONFIGURED hours (CD-8)", () => {
    const custom = getResearchConfig({
      RESEARCH_DELIVERY_QUIET_START_HOUR_ET: "22",
      RESEARCH_DELIVERY_QUIET_END_HOUR_ET: "7",
    } as unknown as NodeJS.ProcessEnv);
    const decision = deliveryDecision({ now: NIGHT_ET, deliveryClass: "routine", latestDutyStatus: "off_duty", config: custom });
    expect(decision.sendNow).toBe(false);
    expect(decision.reason).toContain("quiet hours (22:00-07:00 ET)");
    expect(decision.reason).not.toContain("21:00-06:00");
  });

  it("routine holds while driving, capped at the max hold", () => {
    const decision = deliveryDecision({ now: DAY_ET, deliveryClass: "routine", latestDutyStatus: "driving", config });
    expect(decision.sendNow).toBe(false);
    expect(decision.heldUntil?.getTime()).toBe(DAY_ET.getTime() + config.deliveryHoldMaxHours * 3600 * 1000);
    expect(decision.reason).toMatch(/driving/);
  });

  it("routine sends immediately on a parked daytime", () => {
    expect(
      deliveryDecision({ now: DAY_ET, deliveryClass: "routine", latestDutyStatus: "off_duty", config }).sendNow,
    ).toBe(true);
    expect(
      deliveryDecision({ now: DAY_ET, deliveryClass: "trip", latestDutyStatus: null, config }).sendNow,
    ).toBe(true);
  });
});

describe("message formats", () => {
  const briefing = { topic: "fuel", title: "Diesel spiked", headline: "Up 5%.", counterMove: "Fuel in Georgia.", takeaway: "Fill before Sunday." };

  it("a single briefing carries the counter-move line", () => {
    const text = formatBriefingMessage(briefing);
    expect(text).toContain("Diesel spiked");
    expect(text).toContain("Counter-move: Fuel in Georgia.");
  });

  it("a digest lists every held briefing; a one-briefing flush is just the briefing", () => {
    const other = { ...briefing, title: "Rule changed", headline: "New ELD rule." };
    const digest = formatDigestMessage([briefing, other]);
    expect(digest).toContain("2 research briefings");
    expect(digest).toContain("Rule changed");
    expect(formatDigestMessage([briefing])).toBe(formatBriefingMessage(briefing));
  });
});
