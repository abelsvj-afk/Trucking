"use client";

// The drive map's "where am I" pill data (2026-11-19). Asks the server
// sparingly — after the truck has moved about a mile, or every few
// minutes — and keeps the last answer. A failure keeps the last good
// answer only while it is still near; otherwise nothing is shown.

import { useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { haversineMiles, type LatLng } from "@/lib/smart-path";
import type { WhereHere } from "@/lib/drive-where";

const REQUERY_MILES = 0.8;
const REQUERY_MS = 3 * 60_000;
const STALE_MILES = 3;

export function useWhereAmI(position: LatLng | null, headingDeg: number | null): WhereHere | null {
  const [state, setState] = useState<{ at: LatLng; where: WhereHere } | null>(null);
  const lastAsk = useRef<{ at: LatLng; ms: number } | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!position || busy.current) return;
    const last = lastAsk.current;
    if (last && haversineMiles(last.at, position) < REQUERY_MILES && Date.now() - last.ms < REQUERY_MS) return;
    busy.current = true;
    const at = { lat: position.lat, lng: position.lng };
    lastAsk.current = { at, ms: Date.now() };
    apiClient
      .whereAmI(at.lat, at.lng, headingDeg)
      .then((res) => setState({ at, where: res.data }))
      .catch(() => undefined)
      .finally(() => {
        busy.current = false;
      });
  }, [position, headingDeg]);

  if (!state || !position || haversineMiles(state.at, position) > STALE_MILES) return null;
  return state.where;
}
