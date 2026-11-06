"use client";

// The posted speed limit for the road under the truck (Block C). Asks the server (OSM
// maxspeed) sparingly, and only ever hands back a limit that is fresh and still belongs
// to where the truck is. A failure, no data, or a truck that has moved on all give null:
// the badge disappears, it is never replaced by a guess.

import { useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { limitIsShowable, shouldQuerySpeedLimit, type LimitLookup } from "@/lib/speed-limit-policy";
import { useNowTick } from "@/lib/use-now-tick";
import type { VehiclePosition } from "@/lib/use-vehicle-motion";

export function useSpeedLimit(position: VehiclePosition | null, headingDeg: number | null, moving: boolean): number | null {
  const nowMs = useNowTick(5_000);
  const [result, setResult] = useState<{ limitMph: number | null; lookup: LimitLookup } | null>(null);
  const lastRef = useRef<LimitLookup | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!position || inFlight.current) return;
    const here = { lat: position.lat, lng: position.lng };
    if (!shouldQuerySpeedLimit(lastRef.current, Date.now(), here, moving)) return;
    inFlight.current = true;
    const lookup: LimitLookup = { atMs: Date.now(), point: here };
    lastRef.current = lookup;
    apiClient
      .speedLimit(here.lat, here.lng, headingDeg)
      .then((res) => setResult({ limitMph: res.data.unavailable ? null : res.data.limitMph, lookup }))
      .catch(() => setResult({ limitMph: null, lookup }))
      .finally(() => {
        inFlight.current = false;
      });
  }, [position, headingDeg, moving, nowMs]);

  return limitIsShowable(result, nowMs, position ? { lat: position.lat, lng: position.lng } : null);
}
