// GAP-05: load closeout — required-vs-attached paperwork rules.

import { describe, expect, it } from "vitest";
import { computePaperwork } from "@/lib/paperwork";
import type { Load } from "@/types/entities";

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
    detention_free_minutes: null,
    detention_rate_cents_per_hour: null,
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

const doc = (id: string, doc_type: string | null) => ({ id, doc_type });

describe("computePaperwork", () => {
  it("always requires the rate con and the BOL/POD", () => {
    const state = computePaperwork(load(), [], []);
    expect(state.complete).toBe(false);
    expect(state.missing.map((m) => m.kind)).toEqual(["rate_confirmation", "bol"]);
    expect(state.summaryLine).toContain("rate confirmation");
  });

  it("is complete when both are attached", () => {
    const state = computePaperwork(load(), [doc("d1", "rate_confirmation"), doc("d2", "bol")], []);
    expect(state.complete).toBe(true);
  });

  it("requires a scale ticket only when the load carries weight", () => {
    const light = computePaperwork(load(), [doc("d1", "rate_confirmation"), doc("d2", "bol")], []);
    expect(light.items.map((i) => i.kind)).not.toContain("scale_ticket");
    const heavy = computePaperwork(load({ weight_lbs: 42000 }), [doc("d1", "rate_confirmation"), doc("d2", "bol")], []);
    expect(heavy.complete).toBe(false);
    expect(heavy.missing.map((m) => m.kind)).toEqual(["scale_ticket"]);
  });

  it("requires a lumper receipt when a lumper expense is booked, satisfied by an extra document", () => {
    const expenses = [{ category: "other" as const, description: "Lumper fee — Wildwood" }];
    const missing = computePaperwork(load(), [doc("d1", "rate_confirmation"), doc("d2", "bol")], expenses);
    expect(missing.missing.map((m) => m.kind)).toEqual(["lumper_receipt"]);
    const satisfied = computePaperwork(
      load(),
      [doc("d1", "rate_confirmation"), doc("d2", "bol"), doc("d3", "other")],
      expenses,
    );
    expect(satisfied.complete).toBe(true);
  });

  it("a non-lumper expense does not trigger the receipt requirement", () => {
    const state = computePaperwork(
      load(),
      [doc("d1", "rate_confirmation"), doc("d2", "bol")],
      [{ category: "other" as const, description: "Tolls" }],
    );
    expect(state.complete).toBe(true);
  });
});
