import { beforeEach, describe, expect, it, vi } from "vitest";
import { isTrailering, pickNextStop } from "@/lib/next-stop";
import { buildActiveLoadState, clearActiveRouteCache, describeActiveLoadState, MAX_START_AGE_MS, NOT_TRUCK_LEGAL_NOTICE } from "@/services/navigation/active-load-state";
import { createCachedGeocoder, MISS_RETRY_MS, normalizeQuery } from "@/services/navigation/geocode-cache";
import { buildNavigationTools } from "@/services/bot/navigation-tools";
import { GeocodingUnavailableError } from "@/services/integrations/geocoding";
import { RoutingUnavailableError, type RouteResult } from "@/services/integrations/routing";
import type { Load, LoadStop } from "@/types/entities";

const NOW = new Date("2026-11-10T18:00:00Z"); // 1:00 PM Eastern
const load = (o: Partial<Load> = {}): Load => ({ pickup_window_end: null, id: "L1", status: "confirmed", origin: "Joplin, MO", destination: "Tampa, FL", pickup_date: "2026-11-10", delivery_date: "2026-11-12", truck_id: "T1", trailer_id: "TR1", trip_number: "1234", deleted_at: null, ...o }) as Load;
const stop = (o: Partial<LoadStop>): LoadStop => ({ id: "S1", load_id: "L1", seq: 1, kind: "pickup", name: "Acme DC", address: "100 Dock Rd, Joplin, MO", appointment_at: null, appointment_tz: null, arrived_at: null, departed_at: null, approved_at: null, notes: null, deleted_at: null, ...o }) as LoadStop;

/** A tiny in-memory stand-in for the tables the builder reads, plus the geocode_cache upsert. */
function fakeClient(tables: { loads?: Load[]; load_stops?: LoadStop[]; driver_positions?: Record<string, unknown>[]; trucks?: Record<string, unknown>[]; geocode_cache?: Record<string, unknown>[]; cacheMissing?: boolean }) {
  const cache = tables.geocode_cache ?? [];
  const calls: string[] = [];
  const from = (table: string) => {
    calls.push(table);
    const filters: [string, unknown][] = [];
    const b: Record<string, unknown> = {};
    for (const m of ["select", "is", "order", "limit", "in"]) b[m] = () => b;
    b.eq = (k: string, v: unknown) => { filters.push([k, v]); return b; };
    const rows = () => {
      if (table === "geocode_cache") return cache.filter((r) => filters.every(([k, v]) => r[k] === v));
      const all = ((tables as Record<string, unknown>)[table] as Record<string, unknown>[] | undefined) ?? [];
      return all.filter((r) => filters.every(([k, v]) => !(k in r) || r[k] === v));
    };
    const result = () => (table === "geocode_cache" && tables.cacheMissing ? { data: null, error: { message: 'relation "geocode_cache" does not exist' } } : { data: rows(), error: null });
    b.maybeSingle = async () => { const r = result(); return { data: r.data ? (r.data[0] ?? null) : null, error: r.error }; };
    b.upsert = async (row: Record<string, unknown>) => { const i = cache.findIndex((r) => r.query === row.query); if (i >= 0) cache[i] = row; else cache.push(row); return { error: null }; };
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
    return b;
  };
  return { client: { from } as never, cache, calls };
}

const route = (o: Partial<RouteResult> = {}): RouteResult => ({ distanceMiles: 412.34, durationMinutes: 400.4, geometry: [{ lat: 37, lng: -94 }, { lat: 28, lng: -82 }], providerName: "OpenRouteService (driving-hgv)", truckLegal: true, providerNotes: [], maneuvers: [{ instruction: "Turn right onto I-44", distanceMiles: 1, atFraction: 0 }], ...o });
const position = (minutesOld: number) => ({ company_id: "c", lat: 37.08, lng: -94.51, heading_deg: 90, speed_mph: 0, recorded_at: new Date(NOW.getTime() - minutesOld * 60_000).toISOString() });
const geocoding = { name: "fake", geocode: vi.fn(async () => ({ lat: 37.1, lng: -94.5 })) };
const deps = (over: Record<string, unknown> = {}) => ({ now: () => NOW, geocoding, routing: { name: "r", getRoute: vi.fn(async () => route()) }, ...over });

beforeEach(() => { clearActiveRouteCache(); geocoding.geocode.mockClear(); });

describe("pickNextStop", () => {
  it("is the first stop he has not left; an arrived-not-left stop is still current", () => {
    const stops = [stop({ id: "a", seq: 1, departed_at: "2026-11-10T15:00:00Z" }), stop({ id: "b", seq: 2, kind: "delivery", arrived_at: "2026-11-10T17:00:00Z" }), stop({ id: "c", seq: 3, kind: "delivery" })];
    expect(pickNextStop(load(), stops, NOW, "2026-11-10")).toMatchObject({ source: "stop", stopId: "b", arrived: true, kind: "delivery" });
  });
  it("a pickup marked left wins over every date rule", () => {
    const stops = [stop({ id: "a", seq: 1, departed_at: "2026-11-10T15:00:00Z" }), stop({ id: "b", seq: 2, kind: "delivery" })];
    expect(pickNextStop(load({ pickup_window_end: "2026-11-12T00:00:00Z" }), stops, NOW, "2026-11-10")).toMatchObject({ stopId: "b", kind: "delivery" });
  });
  it("every stop left = no next stop", () => {
    expect(pickNextStop(load(), [stop({ departed_at: "x" })], NOW, "2026-11-10")).toBeNull();
  });
  it("without stop records it stays on the origin until the pickup WINDOW ENDS, then flips - and says the basis", () => {
    const l = load({ pickup_window_end: "2026-11-10T19:00:00Z" }); // window ends 2:00 PM Eastern; NOW is 1:00 PM
    const before = pickNextStop(l, [], NOW, "2026-11-10")!;
    expect(before).toMatchObject({ source: "load_text", kind: "pickup", address: "Joplin, MO" });
    expect(before.basis).toMatch(/until the pickup appointment window ends/);
    const after = pickNextStop(l, [], new Date("2026-11-10T19:00:01Z"), "2026-11-10")!;
    expect(after).toMatchObject({ kind: "delivery", address: "Tampa, FL" });
    expect(after.basis).toMatch(/window has ended/);
  });
  it("on the pickup day with a window still open it does NOT point at the delivery (freight still on the dock)", () => {
    const l = load({ pickup_date: "2026-11-09", pickup_window_end: "2026-11-10T23:00:00Z" });
    expect(pickNextStop(l, [], NOW, "2026-11-10")).toMatchObject({ kind: "pickup" });
  });
  it("with no window it uses the end of the pickup date; with nothing it stays on the origin", () => {
    expect(pickNextStop(load(), [], NOW, "2026-11-10")).toMatchObject({ kind: "pickup" });
    expect(pickNextStop(load(), [], NOW, "2026-11-11")).toMatchObject({ kind: "delivery" });
    const none = pickNextStop(load({ pickup_date: null }), [], NOW, "2026-12-01")!;
    expect(none.kind).toBe("pickup");
    expect(none.basis).toMatch(/no stop records, pickup window or pickup date/);
  });
  it("trailering = the active load has a trailer", () => {
    expect(isTrailering(load())).toBe(true);
    expect(isTrailering(load({ trailer_id: null }))).toBe(false);
  });
});

describe("buildActiveLoadState: one source of truth", () => {
  it("no confirmed load = no active load, nothing invented", async () => {
    const s = await buildActiveLoadState(fakeClient({ loads: [] }).client, "c", deps());
    expect(s).toMatchObject({ load: null, nextStop: null, route: null });
    expect(describeActiveLoadState(s)).toMatch(/No active load/);
  });

  it("active load + next stop + route from the last known position, with ETA and provider", async () => {
    const d = deps();
    const s = await buildActiveLoadState(fakeClient({ loads: [load()], load_stops: [stop({})], driver_positions: [position(4)], trucks: [{ id: "T1", company_id: "c", height_in: 162, length_in: 840, weight_lbs: 78000 }] }).client, "c", d);
    expect(s.load).toMatchObject({ id: "L1", trailering: true, tripNumber: "1234" });
    expect(s.nextStop).toMatchObject({ stopId: "S1", address: "100 Dock Rd, Joplin, MO", point: { lat: 37.1, lng: -94.5 } });
    expect(s.route).toMatchObject({ distanceMiles: 412.3, durationMinutes: 400, truckLegal: true, guidanceAllowed: true, notTruckLegalNotice: null });
    expect(s.route!.etaAt).toBe(new Date(NOW.getTime() + 400 * 60_000).toISOString());
    expect(s.route!.maneuvers).toHaveLength(1);
    expect(d.routing.getRoute).toHaveBeenCalledWith({ lat: 37.08, lng: -94.51 }, { lat: 37.1, lng: -94.5 }, { heightIn: 162, lengthIn: 840, weightLbs: 78000 }, { headingDeg: null }); // parked: no heading sent
    const text = describeActiveLoadState(s);
    expect(text).toContain("412.3 miles");
    expect(text).toMatch(/ETA Tue 7:40 PM ET/); // Eastern, never UTC
    expect(text).not.toMatch(/UTC|Z\b/);
    expect(text).toContain("Trailer on the load (no U-turns)");
  });

  it("PROVIDER HONESTY: a car-profile route is shown but stamped not truck-legal, guidance is refused and no turn list is carried", async () => {
    const d = deps({ routing: { name: "r", getRoute: vi.fn(async () => route({ truckLegal: false, providerName: "OSRM (car profile)" })) } });
    const s = await buildActiveLoadState(fakeClient({ loads: [load()], driver_positions: [position(1)] }).client, "c", d);
    expect(s.route).toMatchObject({ truckLegal: false, guidanceAllowed: false, notTruckLegalNotice: NOT_TRUCK_LEGAL_NOTICE, maneuvers: [] });
    expect(s.route!.geometry.length).toBeGreaterThan(1); // it may still be displayed
    expect(describeActiveLoadState(s)).toContain("NOT truck-legal");
  });

  it("the device's own fix wins over the server position", async () => {
    const d = deps({ devicePosition: { lat: 30, lng: -85, headingDeg: 180 } });
    const s = await buildActiveLoadState(fakeClient({ loads: [load()], driver_positions: [position(1)] }).client, "c", d);
    expect(s.position).toMatchObject({ source: "device", lat: 30, lng: -85, ageSeconds: 0 });
    expect((d.routing.getRoute as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual({ lat: 30, lng: -85 });
  });

  it("no route is invented: no position, a stale position, an unknown address, a geocoder outage, a routing outage", async () => {
    const none = await buildActiveLoadState(fakeClient({ loads: [load()] }).client, "c", deps());
    expect(none.route).toBeNull();
    expect(none.routeUnavailableReason).toMatch(/don't know where the truck is/);

    const stale = await buildActiveLoadState(fakeClient({ loads: [load()], driver_positions: [position(MAX_START_AGE_MS / 60_000 + 5)] }).client, "c", deps());
    expect(stale.route).toBeNull();
    expect(stale.routeUnavailableReason).toMatch(/65 minutes old/);

    const miss = await buildActiveLoadState(fakeClient({ loads: [load()], driver_positions: [position(1)] }).client, "c", deps({ geocoding: { name: "g", geocode: async () => null } }));
    expect(miss.routeUnavailableReason).toMatch(/couldn't find "Joplin, MO"/);

    const geoDown = await buildActiveLoadState(fakeClient({ loads: [load()], driver_positions: [position(1)] }).client, "c", deps({ geocoding: { name: "g", geocode: async () => { throw new GeocodingUnavailableError("x"); } } }));
    expect(geoDown.routeUnavailableReason).toMatch(/address lookup service/);

    const routeDown = await buildActiveLoadState(fakeClient({ loads: [load()], driver_positions: [position(1)] }).client, "c", deps({ routing: { name: "r", getRoute: async () => { throw new RoutingUnavailableError("down"); } } }));
    expect(routeDown.route).toBeNull();
    expect(routeDown.routeUnavailableReason).toMatch(/Nothing was guessed/);
    expect(describeActiveLoadState(routeDown)).toMatch(/ROUTE: none/);
  });

  it("two reads moments apart (the map, then Abel) share one routing call and give the same numbers", async () => {
    const d = deps();
    const c = fakeClient({ loads: [load()], driver_positions: [position(1)] });
    const a = await buildActiveLoadState(c.client, "c", d);
    const b = await buildActiveLoadState(c.client, "c", d);
    expect(d.routing.getRoute).toHaveBeenCalledTimes(1);
    expect(b.route!.distanceMiles).toBe(a.route!.distanceMiles);
  });
});

describe("geocode cache (migration 00089): an address is looked up once", () => {
  const inner = () => ({ name: "Nominatim", geocode: vi.fn(async () => ({ lat: 1, lng: 2 })) });
  it("stores the answer and never asks the provider again - even from a fresh process", async () => {
    const c = fakeClient({});
    const first = inner();
    expect(await createCachedGeocoder(c.client, "c", first, () => NOW).geocode("  100 Dock Rd,  Joplin, MO ")).toEqual({ lat: 1, lng: 2 });
    expect(c.cache[0]).toMatchObject({ company_id: "c", query: "100 dock rd, joplin, mo", lat: 1, lng: 2 });
    const second = inner(); // a new process: no in-memory state, only the table
    expect(await createCachedGeocoder(c.client, "c", second, () => NOW).geocode("100 Dock Rd, Joplin, MO")).toEqual({ lat: 1, lng: 2 });
    expect(second.geocode).not.toHaveBeenCalled();
    expect(normalizeQuery(" A  b ")).toBe("a b");
  });
  it("records a not-found, does not retry it at once, and retries after the retry window", async () => {
    const c = fakeClient({});
    const miss = { name: "n", geocode: vi.fn(async () => null) };
    expect(await createCachedGeocoder(c.client, "c", miss, () => NOW).geocode("nowhere")).toBeNull();
    expect(await createCachedGeocoder(c.client, "c", miss, () => NOW).geocode("nowhere")).toBeNull();
    expect(miss.geocode).toHaveBeenCalledTimes(1);
    await createCachedGeocoder(c.client, "c", miss, () => new Date(NOW.getTime() + MISS_RETRY_MS + 1)).geocode("nowhere");
    expect(miss.geocode).toHaveBeenCalledTimes(2);
  });
  it("an outage is thrown and never cached; a missing table degrades to the plain provider", async () => {
    const c = fakeClient({});
    await expect(createCachedGeocoder(c.client, "c", { name: "n", geocode: async () => { throw new GeocodingUnavailableError("down"); } }, () => NOW).geocode("x")).rejects.toThrow();
    expect(c.cache).toHaveLength(0);
    const noTable = fakeClient({ cacheMissing: true });
    const p = inner();
    expect(await createCachedGeocoder(noTable.client, "c", p, () => NOW).geocode("x")).toEqual({ lat: 1, lng: 2 });
    expect(noTable.cache).toHaveLength(0);
  });
});

describe("Abel's read path: active_load_status", () => {
  it("is a read tool that answers from the same builder", async () => {
    const c = fakeClient({ loads: [load()], load_stops: [stop({})], driver_positions: [position(2)] });
    const tool = buildNavigationTools({ client: c.client, companyId: "c" } as never, deps())[0]!;
    expect(tool.name).toBe("active_load_status");
    expect(tool.access).toBe("read");
    const out = await tool.run({});
    expect(out).toContain("ACTIVE LOAD (trip 1234): Joplin, MO → Tampa, FL");
    expect(out).toContain("NEXT STOP: pickup at Acme DC - 100 Dock Rd, Joplin, MO");
    expect(out).toMatch(/412\.3 miles, about 6 h 40 min of driving, ETA .* ET/);
  });
  it("says plainly when it can't read, never a guess", async () => {
    const broken = { from: () => { throw new Error("db down"); } };
    const out = await buildNavigationTools({ client: broken, companyId: "c" } as never, deps())[0]!.run({});
    expect(out).toMatch(/couldn't be read/);
  });
});

describe("U-turn rule on the server state (no U-turns while the load has a trailer)", () => {
  const moving = { company_id: "c", lat: 37.08, lng: -94.51, heading_deg: 90, speed_mph: 55, recorded_at: new Date(NOW.getTime() - 60_000).toISOString() };
  const uturnRoute = route({ maneuvers: [{ instruction: "Make a U-turn onto I-44", distanceMiles: 1, atFraction: 0 }] });
  it("trailering + a labelled U-turn = blocked, and Abel is told not to send him that way", async () => {
    const s = await buildActiveLoadState(fakeClient({ loads: [load()], driver_positions: [moving] }).client, "c", deps({ routing: { name: "r", getRoute: vi.fn(async () => uturnRoute) } }));
    expect(s.route).toMatchObject({ needsUTurn: true, uTurnBlocked: true });
    expect(describeActiveLoadState(s)).toMatch(/NOT allowed with a trailer on/);
  });
  it("bobtail + the same route = allowed", async () => {
    const s = await buildActiveLoadState(fakeClient({ loads: [load({ trailer_id: null })], driver_positions: [moving] }).client, "c", deps({ routing: { name: "r", getRoute: vi.fn(async () => uturnRoute) } }));
    expect(s.route).toMatchObject({ needsUTurn: true, uTurnBlocked: false });
  });
  it("a moving truck's heading is sent to the engine", async () => {
    const d = deps();
    await buildActiveLoadState(fakeClient({ loads: [load()], driver_positions: [moving] }).client, "c", d);
    expect((d.routing.getRoute as ReturnType<typeof vi.fn>).mock.calls[0]![3]).toEqual({ headingDeg: 90 });
  });
});
