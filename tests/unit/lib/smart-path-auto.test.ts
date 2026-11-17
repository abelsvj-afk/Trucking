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
