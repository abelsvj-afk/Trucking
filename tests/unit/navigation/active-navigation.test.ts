import { afterEach, describe, expect, it, vi } from "vitest";
import { bearingDeg, checkUTurn, decideAdoption, etaAgainstClocks, formatMiles, headingDifference, isUTurnInstruction, liveGuidance, NAV_COPY, startsWithReversal, type NavRoute } from "@/lib/active-navigation";
import { applyServerState } from "@/lib/use-active-navigation";
import { ValhallaRoutingProvider } from "@/services/integrations/valhalla";
import type { ActiveLoadState } from "@/services/navigation/active-load-state";

// A straight line due EAST from (37, -94): about 55 miles per degree of longitude here.
const east = [{ lat: 37, lng: -94 }, { lat: 37, lng: -93.9 }, { lat: 37, lng: -93.5 }, { lat: 37, lng: -93 }];
const route = (o: Partial<NavRoute> = {}): NavRoute => ({
  distanceMiles: 55, durationMinutes: 60, truckLegal: true, guidanceAllowed: true, notTruckLegalNotice: null, providerName: "OpenRouteService (driving-hgv)", geometry: east,
  maneuvers: [{ instruction: "Head east on I-44", distanceMiles: 27, atFraction: 0 }, { instruction: "Take exit 80 on the right", distanceMiles: 20, atFraction: 0.5 }, { instruction: "Arrive at your destination", distanceMiles: 0, atFraction: 1 }],
  ...o,
});

describe("U-turn detection", () => {
  it("recognises the engines' words for a reversal and nothing else", () => {
    for (const t of ["Make a U-turn onto Main St", "Make a uturn", "Turn around when possible", "Make a U turn"]) expect(isUTurnInstruction(t), t).toBe(true);
    for (const t of ["Turn right onto Union St", "Keep left", "Return to the route via Turner Rd"]) expect(isUTurnInstruction(t), t).toBe(false);
  });
  it("a line that starts back the way the truck is travelling is a reversal - only judged while actually moving", () => {
    expect(Math.round(bearingDeg(east[0]!, east[1]!))).toBe(90);
    expect(headingDifference(350, 10)).toBe(20);
    expect(startsWithReversal(east, 270, 55)).toBe(true); // travelling west, route goes east
    expect(startsWithReversal(east, 90, 55)).toBe(false);
    expect(startsWithReversal(east, 180, 55)).toBe(false); // a right turn is not a U-turn
    expect(startsWithReversal(east, 270, 2)).toBe(false); // parked: a heading means nothing
    expect(startsWithReversal(east, null, 55)).toBe(false);
  });
  it("checkUTurn reports which evidence", () => {
    expect(checkUTurn(route({ maneuvers: [{ instruction: "Make a U-turn", distanceMiles: 0, atFraction: 0 }] }), 90, 55)).toEqual({ needsUTurn: true, why: "labelled" });
    expect(checkUTurn(route(), 270, 55)).toEqual({ needsUTurn: true, why: "starts-behind" });
    expect(checkUTurn(route(), 90, 55)).toEqual({ needsUTurn: false, why: null });
  });
});

describe("decideAdoption: trailer-aware rerouting and provider honesty", () => {
  const uturn = route({ maneuvers: [{ instruction: "Make a U-turn", distanceMiles: 0, atFraction: 0 }] });
  it("WITH a trailer a reroute that needs a U-turn is refused and the old line stays", () => {
    const d = decideAdoption({ incoming: uturn, current: route(), trailering: true, headingDeg: 90, speedMph: 50 });
    expect(d).toEqual({ adopt: false, reason: "u-turn-with-trailer", notice: NAV_COPY.uTurnRefused });
  });
  it("WITH a trailer and no line yet, a U-turn route is not shown as something to drive", () => {
    const d = decideAdoption({ incoming: route(), current: null, trailering: true, headingDeg: 270, speedMph: 50 });
    expect(d).toMatchObject({ adopt: false, reason: "u-turn-with-trailer", notice: NAV_COPY.uTurnRefusedNoLine });
  });
  it("BOBTAIL may take the U-turn", () => {
    expect(decideAdoption({ incoming: uturn, current: route(), trailering: false, headingDeg: 90, speedMph: 50 })).toMatchObject({ adopt: true, guide: true });
  });
  it("a truck-legal route is adopted with guidance on", () => {
    expect(decideAdoption({ incoming: route(), current: null, trailering: true, headingDeg: 90, speedMph: 50 })).toEqual({ adopt: true, guide: true, notice: null });
  });
  it("a car-profile route may be DRAWN when nothing else is, stamped, with guidance REFUSED", () => {
    const car = route({ truckLegal: false, guidanceAllowed: false, notTruckLegalNotice: "NOT truck-legal", maneuvers: [] });
    expect(decideAdoption({ incoming: car, current: null, trailering: true, headingDeg: 90, speedMph: 50 })).toEqual({ adopt: true, guide: false, notice: "NOT truck-legal" });
  });
  it("a car-profile route NEVER replaces a truck-legal line", () => {
    const car = route({ truckLegal: false, guidanceAllowed: false, maneuvers: [] });
    expect(decideAdoption({ incoming: car, current: route(), trailering: false, headingDeg: 90, speedMph: 50 })).toMatchObject({ adopt: false, reason: "car-route-would-replace-truck-route", notice: NAV_COPY.carKept });
  });
});

describe("liveGuidance: distance, ETA and turns from where the truck is", () => {
  const now = Date.parse("2026-11-10T18:00:00Z");
  it("at the start: the full distance and time, the first turn first", () => {
    const g = liveGuidance(route(), east[0]!, now, true);
    expect(g.onRoute).toBe(true);
    expect(Math.round(g.milesLeft!)).toBe(55);
    expect(Math.round(g.minutesLeft!)).toBe(60);
    expect(g.next!.instruction).toBe("Head east on I-44");
    expect(g.ahead).toHaveLength(3);
  });
  it("part way: the remaining share of the engine's own distance and time; passed turns drop off", () => {
    const g = liveGuidance(route(), east[2]!, now, true); // half way along the line
    expect(g.milesLeft!).toBeCloseTo(27.5, 1);
    expect(Math.round(g.minutesLeft!)).toBe(30);
    expect(g.etaAt).toBe(new Date(now + g.minutesLeft! * 60_000).toISOString());
    expect(g.ahead.map((m) => m.instruction)).toEqual(["Take exit 80 on the right", "Arrive at your destination"]);
    expect(g.traveled.length).toBe(3);
  });
  it("off the line: no progress, no ETA and no turn is claimed", () => {
    const g = liveGuidance(route(), { lat: 38, lng: -94 }, now, true);
    expect(g).toMatchObject({ onRoute: false, milesLeft: null, etaAt: null, next: null, ahead: [] });
  });
  it("guidance off (car route): distance and ETA only, never a turn", () => {
    const g = liveGuidance(route({ truckLegal: false, guidanceAllowed: false }), east[0]!, now, false);
    expect(g.next).toBeNull();
    expect(g.ahead).toEqual([]);
    expect(g.milesLeft).not.toBeNull();
  });
});

describe("the status card's ETA against his real clocks (display only)", () => {
  const eta = "2026-11-10T23:10:00Z"; // 6:10 PM Eastern
  it("says plainly when the ETA is past the drive clock, in the owner's words", () => {
    const line = etaAgainstClocks(eta, 300, { driveLeftMs: 260 * 60_000, windowLeftMs: 600 * 60_000 });
    expect(line).toEqual({ text: "ETA 6:10 PM ET — past your drive clock by ~40 min", past: true });
  });
  it("uses the tighter clock: the 14-hour window when it runs out first", () => {
    const line = etaAgainstClocks(eta, 300, { driveLeftMs: 400 * 60_000, windowLeftMs: 200 * 60_000 });
    expect(line.text).toBe("ETA 6:10 PM ET — past your 14-hour window by ~1 h 40 min");
  });
  it("says how much is to spare when he will make it, and never claims breaks were counted", () => {
    const line = etaAgainstClocks(eta, 120, { driveLeftMs: 200 * 60_000, windowLeftMs: 500 * 60_000 });
    expect(line).toEqual({ text: "ETA 6:10 PM ET — inside your drive clock (1 h 20 min to spare, no breaks counted)", past: false });
  });
  it("is honest when the hours aren't known, and is never in UTC", () => {
    const line = etaAgainstClocks(eta, 120, { driveLeftMs: null, windowLeftMs: null });
    expect(line.text).toBe("ETA 6:10 PM ET — your hours aren't available to compare");
    expect(line.text).not.toMatch(/UTC|23:10/);
  });
  it("labels the ETA in the zone the truck is in, not always ET (map fix 2026-11-12)", () => {
    // 23:10Z is 6:10 PM ET but 5:10 PM CT.
    const line = etaAgainstClocks(eta, 120, { driveLeftMs: 200 * 60_000, windowLeftMs: 500 * 60_000 }, "America/Chicago");
    expect(line).toEqual({ text: "ETA 5:10 PM CT — inside your drive clock (1 h 20 min to spare, no breaks counted)", past: false });
  });
  it("warns only when the ETA is genuinely past the tighter clock, in the truck's zone", () => {
    const line = etaAgainstClocks(eta, 300, { driveLeftMs: 260 * 60_000, windowLeftMs: 600 * 60_000 }, "America/Chicago");
    expect(line).toEqual({ text: "ETA 5:10 PM CT — past your drive clock by ~40 min", past: true });
  });
  it("formats distances for a glance", () => {
    expect(formatMiles(412.3)).toBe("412 mi");
    expect(formatMiles(2.34)).toBe("2.3 mi");
    expect(formatMiles(0.1)).toBe("550 ft");
  });
});

describe("applyServerState: what the map holds after each server answer", () => {
  const state = (o: Partial<ActiveLoadState> = {}): ActiveLoadState => ({
    load: { id: "L1", origin: "A", destination: "B", tripNumber: null, pickupDate: null, deliveryDate: null, overdue: false, trailering: true },
    nextStop: { source: "stop", stopId: "S1", seq: 1, kind: "pickup", name: "Acme DC", address: "1 Dock Rd", appointmentAt: null, appointmentTz: null, arrived: false, basis: null, tripState: "not-started", pickupUnconfirmed: false, point: { lat: 37, lng: -93 } },
    position: null,
    route: { ...route(), etaAt: "2026-11-10T19:00:00Z", providerNotes: [], needsUTurn: false, uTurnBlocked: false },
    routeUnavailableReason: null, asOf: "2026-11-10T18:00:00Z", ...o,
  });
  const empty = { nav: { route: null, guide: false, stopLabel: null, trailering: false, notice: null, unavailableReason: null, basis: null, tripState: null, pickupUnconfirmed: false, rerouting: false }, key: "" };
  const motion = { headingDeg: 90, speedMph: 50 };

  it("first answer: the route is adopted with guidance, labelled with the stop", () => {
    const next = applyServerState(empty, state(), motion, false);
    expect(next.nav).toMatchObject({ guide: true, stopLabel: "Acme DC", trailering: true, notice: null });
    expect(next.nav.route!.distanceMiles).toBe(55);
  });
  it("trip state flows through: a pickup-unknown answer carries its flag and basis", () => {
    const s = state({ nextStop: { ...state().nextStop!, stopId: "S2", kind: "delivery", name: "Kontoor Seminole", basis: "The pickup was never marked left — the truck is 514 mi from Kontoor Panama City and the pickup window has ended, so I'm aiming at the delivery instead. Tap 'I left' on the pickup to confirm.", tripState: "pickup-unknown", pickupUnconfirmed: true } });
    const next = applyServerState(empty, s, motion, false);
    expect(next.nav).toMatchObject({ tripState: "pickup-unknown", pickupUnconfirmed: true });
    expect(next.nav.basis).toMatch(/never marked left/);
  });
  it("a reroute that needs a U-turn while trailering keeps the old line and says why", () => {
    const first = applyServerState(empty, state(), motion, false);
    const bad = state({ route: { ...state().route!, distanceMiles: 99, maneuvers: [{ instruction: "Make a U-turn", distanceMiles: 0, atFraction: 0 }] } });
    const next = applyServerState(first, bad, motion, true);
    expect(next.nav.route!.distanceMiles).toBe(55);
    expect(next.nav.notice).toBe(NAV_COPY.uTurnRefused);
  });
  it("a successful reroute replaces the line and says so", () => {
    const first = applyServerState(empty, state(), motion, false);
    const next = applyServerState(first, state({ route: { ...state().route!, distanceMiles: 40 } }), motion, true);
    expect(next.nav.route!.distanceMiles).toBe(40);
    expect(next.nav.notice).toBe(NAV_COPY.rerouted);
  });
  it("a new next stop drops the old line (it no longer leads where he is going)", () => {
    const first = applyServerState(empty, state(), motion, false);
    const moved = state({ nextStop: { ...state().nextStop!, stopId: "S2", name: "Receiver" }, route: null, routeUnavailableReason: "No routing service could be reached right now" });
    const next = applyServerState(first, moved, motion, false);
    expect(next.nav.route).toBeNull();
    expect(next.nav.unavailableReason).toMatch(/No routing service/);
  });
  it("a failed refresh for the SAME stop keeps the last good line and says it is the last one", () => {
    const first = applyServerState(empty, state(), motion, false);
    const next = applyServerState(first, state({ route: null, routeUnavailableReason: "down" }), motion, false);
    expect(next.nav.route).not.toBeNull();
    expect(next.nav.notice).toMatch(/showing the last one/);
  });
  it("a car-only answer is drawn with guidance off and the not-truck-legal notice", () => {
    const car = state({ route: { ...state().route!, truckLegal: false, guidanceAllowed: false, notTruckLegalNotice: "NOT truck-legal: ...", maneuvers: [] } });
    const next = applyServerState(empty, car, motion, false);
    expect(next.nav).toMatchObject({ guide: false, notice: "NOT truck-legal: ..." });
    expect(next.nav.route!.truckLegal).toBe(false);
  });
  it("no active load = nothing on the map", () => {
    expect(applyServerState(empty, state({ load: null, nextStop: null, route: null }), motion, false).nav.route).toBeNull();
  });
});

describe("Valhalla is told the truck's heading", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends heading + tolerance on the start location when a heading is given, and not otherwise", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return { ok: false, status: 503, json: async () => ({}) } as never; }));
    const p = new ValhallaRoutingProvider("https://valhalla.test");
    await p.getRoute({ lat: 37, lng: -94 }, { lat: 37, lng: -93 }, null, { headingDeg: 271.4 }).catch(() => undefined);
    await p.getRoute({ lat: 37, lng: -94 }, { lat: 37, lng: -93 }, null).catch(() => undefined);
    expect((bodies[0]!.locations as Record<string, unknown>[])[0]).toMatchObject({ heading: 271, heading_tolerance: 60 });
    expect((bodies[1]!.locations as Record<string, unknown>[])[0]).toEqual({ lat: 37, lon: -94 });
  });
});
