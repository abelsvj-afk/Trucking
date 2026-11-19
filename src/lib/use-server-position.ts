"use client";

// The truck's last position as the SERVER knows it (the Tracker app, or
// Telegram Live Location). Home's map uses it while this device has no GPS
// fix of its own (just reopened, GPS warming up, permission off).
//
// Owner 2026-11-19: "the truck should always be there regardless". Until
// then a server fix older than 3 minutes was dropped and Home showed a
// "no fresh location" card with NO truck. Now the truck stays on the map at
// its LAST KNOWN position at any age — clearly marked `stale` (the card says
// "last known · 2 h ago — not live"), never passed off as a live fix. The
// last good fix is also remembered on this phone, so even with the server
// unreachable the truck still sits where it was last seen.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useNowTick } from "@/lib/use-now-tick";

/** Newer than this = live; older = shown as "last known". */
export const SERVER_FIX_FRESH_MS = 3 * 60_000;
const POLL_MS = 15_000;
const REMEMBER_KEY = "trucking.home.last-position.v1";

export interface ServerPosition {
  lat: number;
  lng: number;
  accuracyM: number;
  atMs: number;
  headingDeg: number | null;
  speedMph: number | null;
  /** Older than SERVER_FIX_FRESH_MS: where the truck WAS, not where it is. */
  stale: boolean;
  source: "server" | "remembered";
}

type Raw = { lat: number; lng: number; accuracyM: number | null; headingDeg: number | null; speedMph: number | null; ageSeconds: number } | null;

/** Pure: the server fix at any age, marked stale when old. Null only when there is none. */
export function usableServerFix(raw: Raw, fetchedAtMs: number, nowMs: number): ServerPosition | null {
  if (!raw || !Number.isFinite(raw.lat) || !Number.isFinite(raw.lng)) return null;
  const atMs = fetchedAtMs - raw.ageSeconds * 1000;
  return {
    lat: raw.lat,
    lng: raw.lng,
    accuracyM: raw.accuracyM ?? 50,
    atMs,
    headingDeg: raw.headingDeg,
    speedMph: raw.speedMph,
    stale: nowMs - atMs > SERVER_FIX_FRESH_MS,
    source: "server",
  };
}

/** The last good position remembered on this phone (any age), or null. */
export function readRememberedPosition(): ServerPosition | null {
  try {
    const raw = window.localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { lat: number; lng: number; atMs: number; headingDeg: number | null };
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !Number.isFinite(p.atMs)) return null;
    return { lat: p.lat, lng: p.lng, accuracyM: 50, atMs: p.atMs, headingDeg: p.headingDeg ?? null, speedMph: null, stale: true, source: "remembered" };
  } catch {
    return null;
  }
}

/** Remember a good live position on this phone (called with live fixes only). */
export function rememberPosition(p: { lat: number; lng: number; atMs: number; headingDeg: number | null }): void {
  try {
    window.localStorage.setItem(REMEMBER_KEY, JSON.stringify({ lat: p.lat, lng: p.lng, atMs: p.atMs, headingDeg: p.headingDeg }));
  } catch {
    // Private mode / storage full: the server copy still covers it.
  }
}

/** Polls only while `enabled` (i.e. while the device has no fix of its own). */
export function useServerPosition(enabled: boolean): ServerPosition | null {
  const nowMs = useNowTick(5_000);
  const [last, setLast] = useState<{ raw: Raw; fetchedAtMs: number } | null>(null);
  const [remembered] = useState<ServerPosition | null>(() => (typeof window === "undefined" ? null : readRememberedPosition()));
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = () => {
      apiClient
        .telegramPosition()
        .then((res) => !cancelled && setLast({ raw: res.position, fetchedAtMs: Date.now() }))
        // A failed poll keeps the last answer: the truck never vanishes because one request failed.
        .catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);
  if (!enabled) return null;
  const server = last ? usableServerFix(last.raw, last.fetchedAtMs, nowMs) : null;
  // The newer of the server's last fix and the one remembered on this phone.
  if (server && (!remembered || server.atMs >= remembered.atMs)) return server;
  return remembered;
}
