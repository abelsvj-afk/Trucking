"use client";

// The truck's last position as the SERVER knows it - Telegram Live Location keeps reporting with the
// app closed and the screen off. Home's map uses it while this device has no GPS fix of its own
// (just reopened, GPS still warming up, permission off), so the map is never blank when the truck's
// position is actually known. It is labelled as Telegram's, with its age; it is never presented as a
// live phone fix, and it expires: nothing older than SERVER_FIX_FRESH_MS is shown.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useNowTick } from "@/lib/use-now-tick";

export const SERVER_FIX_FRESH_MS = 3 * 60_000;
const POLL_MS = 15_000;

export interface ServerPosition {
  lat: number;
  lng: number;
  accuracyM: number;
  atMs: number;
  headingDeg: number | null;
  speedMph: number | null;
}

/** Pure: the usable server fix, or null when absent/old. */
export function usableServerFix(
  raw: { lat: number; lng: number; accuracyM: number | null; headingDeg: number | null; speedMph: number | null; ageSeconds: number } | null,
  fetchedAtMs: number,
  nowMs: number,
): ServerPosition | null {
  if (!raw) return null;
  const atMs = fetchedAtMs - raw.ageSeconds * 1000;
  if (nowMs - atMs > SERVER_FIX_FRESH_MS) return null;
  return { lat: raw.lat, lng: raw.lng, accuracyM: raw.accuracyM ?? 50, atMs, headingDeg: raw.headingDeg, speedMph: raw.speedMph };
}

/** Polls only while `enabled` (i.e. while the device has no fix of its own). */
export function useServerPosition(enabled: boolean): ServerPosition | null {
  const nowMs = useNowTick(5_000);
  const [last, setLast] = useState<{ raw: Parameters<typeof usableServerFix>[0]; fetchedAtMs: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = () => {
      apiClient
        .telegramPosition()
        .then((res) => !cancelled && setLast({ raw: res.position, fetchedAtMs: Date.now() }))
        .catch(() => !cancelled && setLast(null));
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return enabled && last ? usableServerFix(last.raw, last.fetchedAtMs, nowMs) : null;
}
