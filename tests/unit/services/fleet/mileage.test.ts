// Mileage propagation (Image Intelligence §5.3 / GAP-09): the
// sanity rules are code, the number never moves backwards, and
// every accepted value carries its source. Provenance columns
// land with migration 00045 - before it, the mileage still moves
// and the helper says the stamp didn't happen.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assessOdometerReading,
  propagateMileage,
} from "@/services/fleet/mileage";

const COMPANY = "company-1";
const TRUCK_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-02T12:00:00Z");

describe("assessOdometerReading — the §4.4 sanity rules", () => {
  it("no recorded mileage: any positive reading is plausible", () => {
    expect(
      assessOdometerReading({ currentMiles: null, currentAt: null, candidateMiles: 512_300, now: NOW }),
    ).toEqual({ verdict: "plausible", delta: null });
  });

  it("below the recorded mileage is below_current, with the delta shown", () => {
    expect(
      assessOdometerReading({ currentMiles: 514_020, currentAt: "2026-11-01T12:00:00Z", candidateMiles: 512_300, now: NOW }),
    ).toEqual({ verdict: "below_current", delta: -1720 });
  });

  it("a normal day's driving is plausible", () => {
    const a = assessOdometerReading({
      currentMiles: 514_020,
      currentAt: "2026-11-01T12:00:00Z",
      candidateMiles: 514_900,
      now: NOW,
    });
    expect(a.verdict).toBe("plausible");
  });

  it("a jump past ~1,500 miles per day is suspicious", () => {
    const a = assessOdometerReading({
      currentMiles: 514_020,
      currentAt: "2026-11-02T06:00:00Z",
      candidateMiles: 517_000,
      now: NOW,
    });
    expect(a.verdict).toBe("suspicious_jump");
  });

  it("the same jump spread over enough days is plausible", () => {
    const a = assessOdometerReading({
      currentMiles: 514_020,
      currentAt: "2026-10-30T12:00:00Z",
      candidateMiles: 517_000,
      now: NOW,
    });
    expect(a.verdict).toBe("plausible");
  });

  it("zero or negative readings are invalid", () => {
    expect(assessOdometerReading({ currentMiles: null, currentAt: null, candidateMiles: 0 }).verdict).toBe("invalid");
    expect(assessOdometerReading({ currentMiles: null, currentAt: null, candidateMiles: -5 }).verdict).toBe("invalid");
  });
});

interface TruckState {
  current_mileage: number | null;
  provenance?: Record<string, unknown>;
}

function fakeClient(truck: TruckState | null, opts: { provenanceColumnMissing?: boolean } = {}) {
  const updates: Record<string, unknown>[] = [];
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            is: () => ({
              maybeSingle: async () => ({
                data: truck ? { id: TRUCK_ID, current_mileage: truck.current_mileage } : null,
                error: null,
              }),
            }),
          }),
        }),
      }),
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        return {
          eq: () => ({
            eq: () => ({
              is: async () => {
                if (opts.provenanceColumnMissing && "current_mileage_source" in values) {
                  return { error: { message: 'column "current_mileage_source" does not exist' } };
                }
                if (truck) {
                  if (typeof values.current_mileage === "number") truck.current_mileage = values.current_mileage;
                  if ("current_mileage_source" in values) truck.provenance = values;
                }
                return { error: null };
              },
            }),
          }),
        };
      },
    }),
  };
  return { client: client as unknown as SupabaseClient, updates };
}

describe("propagateMileage — the one door (§5.3)", () => {
  it("applies a forward reading and stamps source + time", async () => {
    const truck: TruckState = { current_mileage: 514_020 };
    const { client } = fakeClient(truck);
    const out = await propagateMileage(client, COMPANY, {
      truckId: TRUCK_ID,
      miles: 514_900,
      source: "odometer_photo",
      at: NOW,
    });
    expect(out).toEqual({ applied: true, previousMiles: 514_020, provenanceRecorded: true });
    expect(truck.current_mileage).toBe(514_900);
    expect(truck.provenance).toMatchObject({
      current_mileage_source: "odometer_photo",
      current_mileage_at: NOW.toISOString(),
    });
  });

  it("declines a backwards reading and touches nothing", async () => {
    const truck: TruckState = { current_mileage: 514_020 };
    const { client, updates } = fakeClient(truck);
    const out = await propagateMileage(client, COMPANY, {
      truckId: TRUCK_ID,
      miles: 512_300,
      source: "fuel_entry",
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("not_forward");
    expect(out.previousMiles).toBe(514_020);
    expect(updates).toHaveLength(0);
    expect(truck.current_mileage).toBe(514_020);
  });

  it("pre-00045: still moves the mileage, reports the stamp as not recorded", async () => {
    const truck: TruckState = { current_mileage: 100 };
    const { client } = fakeClient(truck, { provenanceColumnMissing: true });
    const out = await propagateMileage(client, COMPANY, {
      truckId: TRUCK_ID,
      miles: 250,
      source: "owner_said",
    });
    expect(out).toEqual({ applied: true, previousMiles: 100, provenanceRecorded: false });
    expect(truck.current_mileage).toBe(250);
  });

  it("no such truck: declines plainly", async () => {
    const { client } = fakeClient(null);
    const out = await propagateMileage(client, COMPANY, {
      truckId: TRUCK_ID,
      miles: 250,
      source: "owner_said",
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("no_truck");
  });
});
