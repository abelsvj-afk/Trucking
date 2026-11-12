// Trip-state derivation (map fix 2026-11-12): the card must know whether the trip has started,
// and must never assume the pickup is done without a mark. Cases are built around Trip 1874:
// pickup Kontoor Panama City, never marked left, truck 514 mi away past the pickup window.

import { describe, expect, it } from "vitest";
import { deriveTripState, PICKUP_LEFT_MILES } from "@/lib/trip-state";
import type { LoadStop } from "@/types/entities";

const stop = (over: Partial<LoadStop> & { id: string; seq: number; kind: "pickup" | "delivery" | "other" }): LoadStop => ({
  company_id: "c1",
  load_id: "L",
  name: null,
  address: "1 Test Way",
  appointment_at: null,
  appointment_tz: null,
  arrived_at: null,
  departed_at: null,
  deleted_at: null,
  created_at: "2026-11-10T00:00:00Z",
  updated_at: "2026-11-10T00:00:00Z",
  ...over,
} as LoadStop);

const PICKUP = () => stop({ id: "P", seq: 1, kind: "pickup", name: "Kontoor Panama City", address: "1 Seaport Dr, Panama City, FL" });
const DELIVERY = () => stop({ id: "D", seq: 2, kind: "delivery", name: "Kontoor Seminole", address: "1400 Wrangler Blvd W, Seminole, OK" });

const base = {
  now: new Date("2026-11-10T18:00:00Z"), // 12:00 CST
  pickupWindowEndMs: Date.parse("2026-11-10T22:00:00-06:00"), // 22:00 CST
  pickupDate: "2026-11-10",
  todayIso: "2026-11-10",
};

describe("deriveTripState", () => {
  it("delivered: every stop marked left", () => {
    const r = deriveTripState({ ...base, stops: [PICKUP(), DELIVERY()].map((s) => ({ ...s, departed_at: "2026-11-10T10:00:00Z" })) });
    expect(r).toEqual({ state: "delivered", nextIndex: null, pickupUnconfirmed: false, basis: null });
  });

  it("picked-up then en-route: pickup marked left, next is the delivery, truck well past the pickup", () => {
    const pickup = PICKUP(); pickup.departed_at = "2026-11-10T10:00:00Z";
    const r = deriveTripState({ ...base, stops: [pickup, DELIVERY()], pickupDistanceMiles: 100 });
    expect(r.state).toBe("en-route-to-delivery");
    expect(r.nextIndex).toBe(1);
    expect(r.pickupUnconfirmed).toBe(false);
  });

  it("picked-up just left: pickup marked left, truck still within a couple of miles of it", () => {
    const pickup = PICKUP(); pickup.departed_at = "2026-11-10T10:00:00Z";
    const r = deriveTripState({ ...base, stops: [pickup, DELIVERY()], pickupDistanceMiles: 1 });
    expect(r.state).toBe("picked-up");
    expect(r.nextIndex).toBe(1);
  });

  it("picked-up heading to a second pickup: freight on board, next stop is another pickup", () => {
    const pickup = PICKUP(); pickup.departed_at = "2026-11-10T10:00:00Z";
    const second = stop({ id: "P2", seq: 2, kind: "pickup", name: "Second pickup" });
    const r = deriveTripState({ ...base, stops: [pickup, second, DELIVERY()], pickupDistanceMiles: 50 });
    expect(r.state).toBe("picked-up");
    expect(r.nextIndex).toBe(1);
  });

  it("at-pickup: arrived, not left", () => {
    const pickup = PICKUP(); pickup.arrived_at = "2026-11-10T08:30:00Z";
    const r = deriveTripState({ ...base, stops: [pickup, DELIVERY()] });
    expect(r.state).toBe("at-pickup");
    expect(r.nextIndex).toBe(0);
  });

  it("not-started: pickup neither arrived nor left, no position evidence", () => {
    const r = deriveTripState({ ...base, stops: [PICKUP(), DELIVERY()] });
    expect(r.state).toBe("not-started");
    expect(r.nextIndex).toBe(0);
    expect(r.pickupUnconfirmed).toBe(false);
  });

  it("pickup-unknown: the 1874 case — pickup never marked left, truck 514 mi away, window ended", () => {
    const r = deriveTripState({
      ...base,
      now: new Date("2026-11-11T05:00:00Z"), // 23:00 CST, after the 22:00 window end
      stops: [PICKUP(), DELIVERY()],
      pickupDistanceMiles: 514,
    });
    expect(r.state).toBe("pickup-unknown");
    expect(r.nextIndex).toBe(1);
    expect(r.pickupUnconfirmed).toBe(true);
    expect(r.basis).toContain("never marked left");
    expect(r.basis).toContain("514 mi");
    expect(r.basis).toContain("Kontoor Panama City");
  });

  it("no flip when the window is still open, even 514 mi away", () => {
    const r = deriveTripState({ ...base, stops: [PICKUP(), DELIVERY()], pickupDistanceMiles: 514 });
    expect(r.state).toBe("not-started");
    expect(r.nextIndex).toBe(0);
  });

  it("no flip when close to the pickup, even with the window ended", () => {
    const r = deriveTripState({
      ...base,
      now: new Date("2026-11-11T05:00:00Z"),
      stops: [PICKUP(), DELIVERY()],
      pickupDistanceMiles: 5,
    });
    expect(r.state).toBe("not-started");
    expect(r.nextIndex).toBe(0);
  });

  it("no flip without position evidence, even with the window ended", () => {
    const r = deriveTripState({
      ...base,
      now: new Date("2026-11-11T05:00:00Z"),
      stops: [PICKUP(), DELIVERY()],
      pickupDistanceMiles: null,
    });
    expect(r.state).toBe("not-started");
    expect(r.nextIndex).toBe(0);
  });

  it("the pickup APPOINTMENT time alone never flips: appointment passed, window still open", () => {
    const pickup = PICKUP(); pickup.appointment_at = "2026-11-10T08:00:00-06:00";
    const r = deriveTripState({ ...base, stops: [pickup, DELIVERY()], pickupDistanceMiles: 514 });
    expect(r.state).toBe("not-started");
  });

  it("pickup-unknown with no later stop: honest, with no next stop to aim at", () => {
    const r = deriveTripState({
      ...base,
      now: new Date("2026-11-11T05:00:00Z"),
      stops: [PICKUP()],
      pickupDistanceMiles: 100,
    });
    expect(r.state).toBe("pickup-unknown");
    expect(r.nextIndex).toBe(null);
    expect(r.pickupUnconfirmed).toBe(true);
    expect(r.basis).toContain("no later stop");
  });

  it("pickup-unknown by date: no window recorded, pickup date has passed, truck far away", () => {
    const r = deriveTripState({
      ...base,
      pickupWindowEndMs: null,
      now: new Date("2026-11-11T12:00:00Z"),
      todayIso: "2026-11-11",
      stops: [PICKUP(), DELIVERY()],
      pickupDistanceMiles: 100,
    });
    expect(r.state).toBe("pickup-unknown");
    expect(r.nextIndex).toBe(1);
  });

  it("no pickup stop in the records: the next open stop is the next stop", () => {
    const r = deriveTripState({ ...base, stops: [DELIVERY()] });
    expect(r.state).toBe("en-route-to-delivery");
    expect(r.nextIndex).toBe(0);
    expect(r.pickupUnconfirmed).toBe(false);
  });

  it("deleted stops are ignored", () => {
    const dead = PICKUP(); dead.deleted_at = "2026-11-10T09:00:00Z";
    const r = deriveTripState({ ...base, stops: [dead, DELIVERY()] });
    expect(r.state).toBe("en-route-to-delivery");
    expect(r.nextIndex).toBe(0); // index into the live stops — the deleted pickup is gone
  });

  it("PICKUP_LEFT_MILES is 25", () => {
    expect(PICKUP_LEFT_MILES).toBe(25);
  });
});
