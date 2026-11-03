// GAP-04: detention math — the facility clock, free time, per-
// started-hour billing, assumed-terms labeling, claim pack.

import { describe, expect, it } from "vitest";
import { buildDetentionClaimPack, computeDetention, DEFAULT_FREE_MINUTES } from "@/lib/detention";
import type { DetentionStamp, Load } from "@/types/entities";

function load(overrides: Partial<Load> = {}): Load {
  return {
    id: "l1",
    company_id: "c1",
    truck_id: null,
    driver_id: null,
    broker_id: null,
    customer_id: null,
    origin: "Atlanta, GA",
    destination: "Wildwood, FL",
    pickup_date: null,
    delivery_date: null,
    rate_cents: 250000,
    miles: 450,
    status: "confirmed",
    notes: null,
    pickup_window_start: null,
    pickup_window_end: null,
    delivery_window_start: null,
    delivery_window_end: null,
    detention_free_minutes: 120,
    detention_rate_cents_per_hour: 6500,
    weight_lbs: null,
    pickup_facility_id: null,
    delivery_facility_id: null,
    origin_state: null,
    destination_state: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

let seq = 0;
function stamp(stamp_type: DetentionStamp["stamp_type"], occurred_at: string, stop_kind: "pickup" | "delivery" = "delivery"): DetentionStamp {
  seq += 1;
  return {
    id: `s${seq}`,
    company_id: "c1",
    load_id: "l1",
    stamp_type,
    stop_kind,
    occurred_at,
    notes: null,
    created_at: occurred_at,
    updated_at: occurred_at,
    deleted_at: null,
  };
}

describe("computeDetention", () => {
  it("bills full started hours past free time", () => {
    // Arrive 08:00, depart 12:30 = 270 min; 120 free -> 150 billable -> 3 started hours.
    const summary = computeDetention(load(), [
      stamp("arrival", "2026-10-05T08:00:00Z"),
      stamp("door", "2026-10-05T09:00:00Z"),
      stamp("loading_done", "2026-10-05T12:00:00Z"),
      stamp("departure", "2026-10-05T12:30:00Z"),
    ]);
    expect(summary.totalBillableMinutes).toBe(150);
    expect(summary.totalBillableHours).toBe(3);
    expect(summary.totalOwedCents).toBe(3 * 6500);
    expect(summary.stops[0]!.waitForDoorMinutes).toBe(60);
    expect(summary.stops[0]!.atDoorMinutes).toBe(180);
    expect(summary.anyClockOpen).toBe(false);
  });

  it("owes nothing inside free time", () => {
    const summary = computeDetention(load(), [
      stamp("arrival", "2026-10-05T08:00:00Z"),
      stamp("departure", "2026-10-05T09:30:00Z"),
    ]);
    expect(summary.totalBillableMinutes).toBe(0);
    expect(summary.totalOwedCents).toBe(0);
  });

  it("assumes the standard free time and labels it when terms are missing", () => {
    const summary = computeDetention(load({ detention_free_minutes: null, detention_rate_cents_per_hour: null }), [
      stamp("arrival", "2026-10-05T08:00:00Z"),
      stamp("departure", "2026-10-05T11:00:00Z"),
    ]);
    expect(summary.freeMinutes).toBe(DEFAULT_FREE_MINUTES);
    expect(summary.freeMinutesAssumed).toBe(true);
    expect(summary.totalBillableMinutes).toBe(60);
    // Time computed; money honestly unknown without a rate.
    expect(summary.totalOwedCents).toBeNull();
  });

  it("keeps pickup and delivery clocks separate and sums both", () => {
    const summary = computeDetention(load(), [
      stamp("arrival", "2026-10-05T06:00:00Z", "pickup"),
      stamp("departure", "2026-10-05T09:00:00Z", "pickup"),
      stamp("arrival", "2026-10-05T14:00:00Z", "delivery"),
      stamp("departure", "2026-10-05T18:30:00Z", "delivery"),
    ]);
    // pickup: 180-120=60 -> 1 hr; delivery: 270-120=150 -> 3 hr.
    expect(summary.stops).toHaveLength(2);
    expect(summary.totalOwedCents).toBe(4 * 6500);
  });

  it("an unstamped departure leaves the clock open and unbilled", () => {
    const summary = computeDetention(load(), [stamp("arrival", "2026-10-05T08:00:00Z")]);
    expect(summary.anyClockOpen).toBe(true);
    expect(summary.totalBillableMinutes).toBe(0);
  });
});

describe("buildDetentionClaimPack", () => {
  it("carries times, terms, math, and backing documents", () => {
    const pack = buildDetentionClaimPack({
      load: load(),
      stamps: [
        stamp("arrival", "2026-10-05T08:00:00Z"),
        stamp("departure", "2026-10-05T12:30:00Z"),
      ],
      documentLabels: ["Rate confirmation (Oct 5)", "Signed BOL"],
    });
    expect(pack).toContain("Atlanta, GA → Wildwood, FL");
    expect(pack).toContain("Total detention owed: $195.00");
    expect(pack).toContain("Signed BOL");
  });
});
