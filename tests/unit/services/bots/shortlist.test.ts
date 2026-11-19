// Dispatch Scout shortlist builder: unpriceable, below-floor, and
// Auditor-failing loads are skipped with reasons; only the top
// ranked survivors reach the owner, never padded.
import { describe, expect, it } from "vitest";
import type { BoardLoad } from "@/services/bots/boards";
import { buildShortlist, shortlistProposalPayload } from "@/services/bots/shortlist";

function makeLoad(overrides: Partial<BoardLoad> = {}): BoardLoad {
  return {
    boardSlug: "trulos",
    externalRef: "test-1",
    origin: "Atlanta, GA",
    destination: "Charlotte, NC",
    pickupDate: "2026-11-20",
    equipment: "Dry Van",
    rateCents: 185000,
    rateCentsPerLoadedMile: null,
    weightLbs: 30000,
    loadedMiles: 500,
    deadheadMiles: 100,
    brokerName: "Test Broker",
    brokerCreditScore: 90,
    brokerDaysToPay: 21,
    contactRef: null,
    rawNote: null,
    ...overrides,
  };
}

const INPUT = { costPerMileCents: 120, floorPerAllMileCents: 100, dieselCentsPerGallon: 600, mpg: 7 };

describe("buildShortlist", () => {
  it("shortlists a qualifying load and skips the rest with reasons", () => {
    const result = buildShortlist({
      ...INPUT,
      loads: [
        makeLoad({ externalRef: "good" }),
        // Below the floor: $150,000 on 600 total miles is $44.29 profit per all mile.
        makeLoad({ externalRef: "cheap", rateCents: 150000 }),
        // Unpriceable: no rate at all.
        makeLoad({ externalRef: "no-rate", rateCents: null, rateCentsPerLoadedMile: null }),
        // Above the floor, but the Auditor fails it: flat $200,000 vs
        // $3.00/loaded-mi x 500 mi = $150,000, off by far more than $1.00.
        makeLoad({ externalRef: "bad-math", rateCents: 200000, rateCentsPerLoadedMile: 300 }),
      ],
    });
    expect(result.shortlist.map((entry) => entry.priced.load.externalRef)).toEqual(["good"]);
    expect(result.shortlist[0]?.auditPassed).toBe(true);
    expect(result.shortlist[0]?.warnings).toEqual([]);
    expect(result.skipped).toHaveLength(3);
    const byRef = new Map(result.skipped.map((entry) => [entry.load.externalRef, entry.reason]));
    expect(byRef.get("cheap")).toMatch(/below the floor/i);
    expect(byRef.get("cheap")).toMatch(/floor/);
    expect(byRef.get("no-rate")).toMatch(/no pay/i);
    expect(byRef.get("bad-math")).toMatch(/auditor check failed/i);
    for (const entry of result.skipped) expect(entry.reason.length).toBeGreaterThan(0);
  });

  it("attaches the Florida exit warning to a surviving load", () => {
    const result = buildShortlist({
      ...INPUT,
      loads: [makeLoad({ destination: "Miami, FL" })],
    });
    expect(result.shortlist).toHaveLength(1);
    expect(result.shortlist[0]?.warnings).toEqual([
      "Florida delivery with no exit load priced — price the way out before accepting.",
    ]);
  });

  it("caps the shortlist at the top 5 and skips the rest as ranked below", () => {
    const loads = Array.from({ length: 6 }, (_, index) =>
      makeLoad({ externalRef: `load-${index}`, rateCents: 185000 + index * 1000 }),
    );
    const result = buildShortlist({ ...INPUT, loads });
    expect(result.shortlist).toHaveLength(5);
    expect(result.shortlist[0]?.priced.load.externalRef).toBe("load-5");
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/ranked below the top 5/i);
  });

  it("shortlists fewer when not enough qualify — never pads", () => {
    const result = buildShortlist({
      ...INPUT,
      loads: [makeLoad({ externalRef: "only-one" }), makeLoad({ externalRef: "cheap", rateCents: 150000 })],
    });
    expect(result.shortlist).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
  });

  it("respects a smaller maxShortlist", () => {
    const loads = Array.from({ length: 4 }, (_, index) =>
      makeLoad({ externalRef: `load-${index}`, rateCents: 185000 + index * 1000 }),
    );
    const result = buildShortlist({ ...INPUT, loads, maxShortlist: 3 });
    expect(result.shortlist).toHaveLength(3);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/ranked below the top 3/i);
  });
});

describe("shortlistProposalPayload", () => {
  it("is JSON-safe and carries title-ready fields plus counts", () => {
    const result = buildShortlist({
      ...INPUT,
      loads: [
        makeLoad({ externalRef: "good" }),
        makeLoad({ externalRef: "cheap", rateCents: 150000 }),
      ],
    });
    const payload = shortlistProposalPayload(result);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect(payload["seen"]).toBe(2);
    expect(payload["shortlisted"]).toBe(1);
    expect(payload["skipped"]).toBe(1);
    const loads = payload["loads"];
    expect(Array.isArray(loads)).toBe(true);
    if (!Array.isArray(loads)) throw new Error("payload loads should be an array");
    expect(loads).toHaveLength(1);
    const first = loads[0] as Record<string, unknown>;
    expect(first["origin"]).toBe("Atlanta, GA");
    expect(first["destination"]).toBe("Charlotte, NC");
    expect(first["pay"]).toBe("$1,850.00");
    expect(first["perLoadedMile"]).toBe("$3.70");
    expect(first["perAllMile"]).toBe("$3.08");
    expect(first["brokerName"]).toBe("Test Broker");
    expect(first["brokerCreditScore"]).toBe(90);
    expect(first["brokerDaysToPay"]).toBe(21);
    expect(first["auditPassed"]).toBe(true);
  });

  it("uses null, never undefined, for missing broker and window fields", () => {
    const result = buildShortlist({
      ...INPUT,
      loads: [
        makeLoad({
          pickupDate: null,
          brokerName: null,
          brokerCreditScore: null,
          brokerDaysToPay: null,
          contactRef: null,
        }),
      ],
    });
    const payload = shortlistProposalPayload(result);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    const loads = payload["loads"];
    if (!Array.isArray(loads)) throw new Error("payload loads should be an array");
    const first = loads[0] as Record<string, unknown>;
    expect(first["pickupDate"]).toBeNull();
    expect(first["brokerName"]).toBeNull();
    expect(first["brokerCreditScore"]).toBeNull();
    expect(first["brokerDaysToPay"]).toBeNull();
  });
});
