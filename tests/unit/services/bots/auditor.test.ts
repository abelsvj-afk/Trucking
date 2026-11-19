// Auditor recomputation: miles x rate must equal the pay quoted,
// $ per loaded mile and $ per ALL miles must match the miles given,
// windows must make sense. A number that does not add up is flagged
// with both numbers shown; a missing source is "cannot verify", never
// presented as a fact.
import { describe, expect, it } from "vitest";
import { auditLoadDraft, auditSummary } from "@/services/bots/auditor";

const WINDOWS = {
  pickupWindowStart: "2026-11-20T08:00:00-06:00",
  pickupWindowEnd: "2026-11-20T16:00:00-06:00",
  deliveryWindowStart: "2026-11-21T08:00:00-05:00",
  deliveryWindowEnd: "2026-11-21T16:00:00-05:00",
};

describe("auditor load-draft checks", () => {
  it("passes a clean draft and computes both per-mile figures", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 150000,
      loadedMiles: 500,
      deadheadMiles: 100,
      claimedPerLoadedMileCents: 300,
      claimedPerAllMilesCents: 250,
      ...WINDOWS,
    });
    expect(result.passed).toBe(true);
    expect(result.flags).toEqual([]);
    expect(result.computed.expectedPayCents).toBe(150000);
    expect(result.computed.perLoadedMileCents).toBe(300);
    expect(result.computed.perAllMilesCents).toBe(250);
    expect(auditSummary(result)).toBe("checks out");
  });

  it("flags pay that does not equal rate x loaded miles, with both numbers", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 140000,
      loadedMiles: 500,
      deadheadMiles: 100,
      ...WINDOWS,
    });
    expect(result.passed).toBe(false);
    const pay = result.flags.find((f) => f.field === "pay");
    expect(pay?.severity).toBe("error");
    expect(pay?.claim).toContain("$1,400.00");
    expect(pay?.source).toContain("$1,500.00");
  });

  it("flags a claimed $ per all miles that does not match", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 150000,
      loadedMiles: 500,
      deadheadMiles: 100,
      claimedPerAllMilesCents: 300,
      ...WINDOWS,
    });
    expect(result.passed).toBe(false);
    expect(result.flags.some((f) => f.field === "per-all-miles")).toBe(true);
  });

  it("flags a pickup window that ends before it starts", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 150000,
      loadedMiles: 500,
      deadheadMiles: 100,
      pickupWindowStart: "2026-11-20T16:00:00-06:00",
      pickupWindowEnd: "2026-11-20T08:00:00-06:00",
      deliveryWindowStart: "2026-11-21T08:00:00-05:00",
      deliveryWindowEnd: "2026-11-21T16:00:00-05:00",
    });
    expect(result.passed).toBe(false);
    expect(result.flags.some((f) => f.field === "pickup-window")).toBe(true);
  });

  it("flags a delivery scheduled before the pickup", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 150000,
      loadedMiles: 500,
      deadheadMiles: 100,
      pickupWindowStart: "2026-11-21T08:00:00-06:00",
      pickupWindowEnd: "2026-11-21T16:00:00-06:00",
      deliveryWindowStart: "2026-11-20T08:00:00-05:00",
      deliveryWindowEnd: "2026-11-20T16:00:00-05:00",
    });
    expect(result.flags.some((f) => f.field === "delivery-window")).toBe(true);
  });

  it("says 'cannot verify' — never a guess — when miles or pay are missing", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: null,
      payCents: 150000,
      loadedMiles: null,
      deadheadMiles: null,
      ...WINDOWS,
    });
    expect(result.flags.some((f) => f.severity === "unverifiable")).toBe(true);
    expect(result.flags.every((f) => f.severity !== "error")).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("tolerates rounding: a pay mismatch of $1.00 or less is not an error", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 150050,
      loadedMiles: 500,
      deadheadMiles: 100,
      ...WINDOWS,
    });
    expect(result.flags.filter((f) => f.field === "pay")).toEqual([]);
  });
});
