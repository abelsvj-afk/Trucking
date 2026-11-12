"use client";

// The everyday map's route and guidance state (active-load navigation, points 2-4). It asks the ONE server builder
// (GET /api/v1/active-load - the same one Abel reads) for the route from this device's position to the active load's next stop, and
// decides - with the pure rules in lib/active-navigation.ts - whether that route may be drawn and whether guidance may run on it.
// It asks again when: the load or its stops change (live layer), the truck has been off the line long enough (the Drive Mode rules:
// 0.3 mi for 25 s on a good fix, never more often than every 2 minutes), or a slow refresh comes due. It never invents a line: no
// route from the server = no route here, with the server's plain reason.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { decideAdoption, NAV_COPY, type NavRoute } from "@/lib/active-navigation";
import { distanceToRouteMiles, INITIAL_OFF_ROUTE, mayRequestReroute, stepOffRoute, type OffRouteState } from "@/lib/drive-reroute";
import { useLiveVersion } from "@/lib/use-live";
import type { TripState } from "@/lib/trip-state";
import type { ActiveLoadState } from "@/services/navigation/active-load-state";

export const NAV_REFRESH_MS = 5 * 60_000;

export interface NavPosition {
  lat: number;
  lng: number;
  accuracyM: number;
}

export interface ActiveNavigation {
  /** The route on the map (null = none). */
  route: NavRoute | null;
  /** Turn-by-turn may run on `route` (truck-legal only). */
  guide: boolean;
  /** Where the route goes, in words. */
  stopLabel: string | null;
  trailering: boolean;
  /** A plain message about the last routing decision (refused U-turn, car route kept, off route...). */
  notice: string | null;
  /** Why there is no route, from the server. */
  unavailableReason: string | null;
  /** How the next stop was chosen, when it was not from a stop record. */
  basis: string | null;
  /** The trip's real state (lib/trip-state.ts); null when there is no active load/next stop. */
  tripState: TripState | null;
  /** True when the routing assumes the pickup is done without a departed_at mark. */
  pickupUnconfirmed: boolean;
  rerouting: boolean;
}

const EMPTY: ActiveNavigation = { route: null, guide: false, stopLabel: null, trailering: false, notice: null, unavailableReason: null, basis: null, tripState: null, pickupUnconfirmed: false, rerouting: false };

const stopKey = (s: ActiveLoadState): string => (s.load && s.nextStop ? `${s.load.id}|${s.nextStop.stopId ?? s.nextStop.address}` : "");

/** Pure: fold a fresh server state into what the map shows. Exported for tests. */
export function applyServerState(
  prev: { nav: ActiveNavigation; key: string },
  server: ActiveLoadState,
  motion: { headingDeg: number | null; speedMph: number | null },
  wasReroute: boolean,
): { nav: ActiveNavigation; key: string } {
  if (!server.load || !server.nextStop) return { nav: { ...EMPTY, unavailableReason: server.routeUnavailableReason }, key: "" };
  const key = stopKey(server);
  // A different stop (or load) means the old line no longer leads anywhere he is going.
  const current = key === prev.key ? prev.nav.route : null;
  const base = {
    stopLabel: server.nextStop.name ?? server.nextStop.address,
    trailering: server.load.trailering,
    basis: server.nextStop.basis,
    tripState: server.nextStop.tripState,
    pickupUnconfirmed: server.nextStop.pickupUnconfirmed,
    rerouting: false,
  };
  if (!server.route) {
    return { nav: { ...base, route: current, guide: current ? prev.nav.guide : false, notice: current ? "Couldn't refresh the route just now - showing the last one." : null, unavailableReason: current ? null : server.routeUnavailableReason }, key };
  }
  const incoming: NavRoute = server.route;
  const decision = decideAdoption({ incoming, current, trailering: server.load.trailering, headingDeg: motion.headingDeg, speedMph: motion.speedMph });
  if (!decision.adopt) {
    return { nav: { ...base, route: current, guide: current ? prev.nav.guide : false, notice: decision.notice, unavailableReason: null }, key };
  }
  return { nav: { ...base, route: incoming, guide: decision.guide, notice: decision.notice ?? (wasReroute ? NAV_COPY.rerouted : null), unavailableReason: null }, key };
}

export function useActiveNavigation(position: NavPosition | null, headingDeg: number | null, speedMph: number | null): ActiveNavigation {
  const [held, setHeld] = useState<{ nav: ActiveNavigation; key: string }>({ nav: EMPTY, key: "" });
  const liveVersion = useLiveVersion(["loads", "load_stops"]);
  const latest = useRef({ position, headingDeg, speedMph });
  const inFlight = useRef(false);
  const lastRequestMs = useRef<number | null>(null);
  const offRoute = useRef<OffRouteState>(INITIAL_OFF_ROUTE);
  const heldRef = useRef(held);

  useEffect(() => {
    latest.current = { position, headingDeg, speedMph };
    heldRef.current = held;
  });

  const ask = useCallback((reroute: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastRequestMs.current = Date.now();
    const { position: p, headingDeg: h, speedMph: v } = latest.current;
    if (reroute) setHeld((prev) => ({ ...prev, nav: { ...prev.nav, rerouting: true, notice: NAV_COPY.offRoute } }));
    // Promise.resolve first: any failure to even start the request lands in the same catch as a failed one (the map must never crash).
    Promise.resolve()
      .then(() => apiClient.activeLoad(p ? { lat: p.lat, lng: p.lng, headingDeg: h, speedMph: v } : null))
      .then((res) => setHeld((prev) => applyServerState(prev, res.data, { headingDeg: h, speedMph: v }, reroute)))
      .catch(() => setHeld((prev) => ({ ...prev, nav: { ...prev.nav, rerouting: false, notice: prev.nav.route ? "Couldn't refresh the route just now - showing the last one." : null } })))
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  // Ask when a position first exists, when the load or its stops change, and on a slow refresh.
  const hasPosition = position !== null;
  useEffect(() => {
    const first = setTimeout(() => ask(false), 0);
    const timer = setInterval(() => ask(false), NAV_REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [ask, liveVersion, hasPosition]);

  // Off the line long enough -> a new route from here (never more often than the Drive Mode limit).
  const lat = position?.lat ?? null;
  const lng = position?.lng ?? null;
  const accuracyM = position?.accuracyM ?? null;
  useEffect(() => {
    const route = heldRef.current.nav.route;
    if (!route || lat === null || lng === null) return;
    const nowMs = Date.now();
    const step = stepOffRoute(offRoute.current, { distanceMiles: distanceToRouteMiles({ lat, lng }, route.geometry), accuracyM, nowMs });
    offRoute.current = step.state;
    if (step.offRoute && mayRequestReroute(lastRequestMs.current, nowMs)) {
      const timer = setTimeout(() => ask(true), 0);
      return () => clearTimeout(timer);
    }
  }, [lat, lng, accuracyM, ask]);

  return held.nav;
}
