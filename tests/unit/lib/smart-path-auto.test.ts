// Smart Path v2 (docs/design/smart-path-v2.md): it plans from what the app knows. Fictional data.
import { describe, expect, it } from "vitest";
import { planAuto, type AutoInputs } from "@/lib/smart-path-auto";
import type { LoadStop } from "@/types/entities";

const NOW = new Date("2026-11-17T15:00:00Z");
const stop = (seq: number, kind: LoadStop["kind"], appt: string | null, over: Partial<LoadStop> = {}): LoadStop =>
  ({ id: `s${seq}`, seq, kind, name: null, address: null, appointment_at: appt, appointment_tz: null, arrived_at: null, departed_at: null, approved_at: null, notes: null, deleted_at: null, ...over }) as LoadStop;
const base = (over: Partial<AutoInputs> = {}): AutoInputs => ({
  load: { id: "L1", status: "confirmed", pickup_date: "2026-11-17", delivery_date: "2026-11-19" },
  stops: [stop(1, "pickup", "2026-11-17T20:00:00Z"), stop(2, "delivery", "2026-11-19T11:30:00Z")],
  nextStopKind: "pickup",
  position: { lat: 34.17, lng: -97.14, ageSeconds: 120, source: "server" },
  now: NOW,
  ...over,
});

describe("Smart Path plans from what the app already knows", () => {
  it("heading to the pickup: from the truck, leaving now, windows from the appointments", () => {
    const p = planAuto(base());
    expect(p.phase).toBe("to_pickup");
    expect(p.request).toMatchObject({
      load_id: "L1",
      depart_at: NOW.toISOString(),
      start_point: { lat: 34.17, lng: -97.14 },
      pickup_window: { start: "2026-11-17T20:00:00.000Z", end: "2026-11-17T22:00:00.000Z" },
      delivery_window: { start: "2026-11-19T11:30:00.000Z", end: "2026-11-19T13:30:00.000Z" },
    });
    expect(p.request!.already_picked_up).toBeUndefined();
    expect(p.assumptions[0]).toContain("Heading to the pickup");
    expect(p.assumptions[0]).toContain("the Tracker, 2 min ago");
  });

  it("loaded (halfway to the delivery): the pickup is behind him - plan from the truck straight to the delivery", () => {
    const p = planAuto(base({ nextStopKind: "delivery" }));
    expect(p.phase).toBe("loaded");
    expect(p.request).toMatchObject({ already_picked_up: true, start_point: { lat: 34.17, lng: -97.14 } });
    expect(p.request!.pickup_window).toBeUndefined();
    expect(p.assumptions[0]).toContain("Loaded");
  });

  it("a departed pickup also means loaded, even if the next-stop model lagged", () => {
    const stops = [stop(1, "pickup", null, { departed_at: "2026-11-17T12:00:00Z" }), stop(2, "delivery", null)];
    expect(planAuto(base({ stops, nextStopKind: "pickup" })).phase).toBe("loaded");
  });

  it("no live position, or one too old: plans from the pickup and says why", () => {
    expect(planAuto(base({ position: null }))).toMatchObject({ phase: "no_position" });
    const old = planAuto(base({ position: { lat: 1, lng: 1, ageSeconds: 9 * 3600, source: "server" } }));
    expect(old.phase).toBe("no_position");
    expect(old.request!.start_point).toBeUndefined();
    expect(old.assumptions[0]).toContain("9 h ago - too old to plan from");
  });

  it("a finished load is not planned", () => {
    expect(planAuto(base({ load: { id: "L1", status: "completed", pickup_date: null, delivery_date: null } })).phase).toBe("finished");
  });

  it("remembered preferences ride along; nothing is asked", () => {
    const p = planAuto(base({ prefs: { food_mode: "fast_food", sleep_start_hour: 22, sleep_end_hour: 6, workout: { want: true } } }));
    expect(p.request).toMatchObject({ food_mode: "fast_food", life: { sleep_start_hour: 22, sleep_end_hour: 6, workout: { want: true, minutes: 60, setting: "gym_preferred" } } });
  });
});

describe("Fix A: the verdict is judged against the load's recorded window end, never an invented one", () => {
  // The owner's 2026-11-17 case: a real 8 AM-4 PM delivery window, judged as 8-10 AM, called an
  // 11 AM arrival LATE.
  const recorded = (over: Partial<AutoInputs> = {}): AutoInputs =>
    base({
      load: {
        id: "L1",
        status: "confirmed",
        pickup_date: "2026-11-17",
        delivery_date: "2026-11-19",
        pickup_window_start: "2026-11-17T13:00:00Z",
        pickup_window_end: "2026-11-17T15:00:00Z",
        delivery_window_start: "2026-11-19T13:00:00Z",
        delivery_window_end: "2026-11-19T21:00:00Z",
      },
      ...over,
    });

  it("a recorded 8 AM-4 PM delivery window is used as-is (no invented 2h end)", () => {
    const p = planAuto(recorded());
    expect(p.request).toMatchObject({
      pickup_window: { start: "2026-11-17T13:00:00.000Z", end: "2026-11-17T15:00:00.000Z" },
      delivery_window: { start: "2026-11-19T13:00:00.000Z", end: "2026-11-19T21:00:00.000Z" },
    });
    expect(p.deliveryWindowEstimated).toBe(false);
    expect(p.assumptions.join(" ")).not.toContain("estimate");
  });

  it("no recorded end: falls back to appt+2h and says so in the output", () => {
    const p = planAuto(base());
    expect(p.request).toMatchObject({ delivery_window: { start: "2026-11-19T11:30:00.000Z", end: "2026-11-19T13:30:00.000Z" } });
    expect(p.deliveryWindowEstimated).toBe(true);
    expect(p.assumptions.join(" ")).toContain("The delivery window is an estimate - no end time was recorded for this delivery, so I allowed 2 hours from the appointment.");
  });

  it("a recorded end before the start is not trusted - it falls back to appt+2h, estimated", () => {
    const p = planAuto(recorded({ load: { id: "L1", status: "confirmed", pickup_date: "2026-11-17", delivery_date: "2026-11-19", delivery_window_start: "2026-11-19T13:00:00Z", delivery_window_end: "2026-11-19T12:00:00Z" } }));
    expect(p.request).toMatchObject({ delivery_window: { start: "2026-11-19T13:00:00.000Z", end: "2026-11-19T15:00:00.000Z" } });
    expect(p.deliveryWindowEstimated).toBe(true);
  });
});

import { hoursLine } from "@/lib/smart-path-summary";
import { makeResult } from "../fixtures/route-check-fixture";

describe("the card says which hours it planned on (owner 2026-11-17: 'why does it show late')", () => {
  it("a used-up cycle from the app log is named as the reason", () => {
    const r = makeResult({ clocks: { driveLeftMin: 300, windowLeftMin: 500, breakLeftMin: 480, weekLeftMin: 0, fromLogs: true }, clocksSource: "app_log" });
    const h = hoursLine(r)!;
    expect(h.fromAppLog).toBe(true);
    expect(h.tight).toBe(true);
    expect(h.text).toContain("this app's duty log");
    expect(h.text).toContain("0h 00m on your cycle");
    expect(h.text).toContain("34-hour restart");
  });

  it("ELD hours he entered are labeled as his", () => {
    const r = makeResult({ clocks: { driveLeftMin: 600, windowLeftMin: 780, breakLeftMin: 480, weekLeftMin: 1800, fromLogs: false }, clocksSource: "eld_entered" });
    expect(hoursLine(r)).toMatchObject({ fromAppLog: false, tight: false });
    expect(hoursLine(r)!.text).toContain("your ELD hours");
  });

  it("ELD clocks ride the automatic plan's request", () => {
    const eld = { drive_left_min: 600, window_left_min: 780, cycle_left_min: 1800, entered_at: "2026-11-17T14:00:00Z" };
    const p = planAuto({
      load: { id: "L1", status: "confirmed", pickup_date: null, delivery_date: null },
      stops: [],
      nextStopKind: "delivery",
      position: { lat: 1, lng: 1, ageSeconds: 10, source: "device" },
      now: new Date("2026-11-17T15:00:00Z"),
      eldClocks: eld,
    });
    expect(p.request!.eld_clocks).toEqual(eld);
  });
});
