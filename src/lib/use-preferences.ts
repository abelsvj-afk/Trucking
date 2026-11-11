"use client";

// Client door for the owner's stated preferences (GET/PUT
// /api/v1/preferences, UI/UX Phase 4). GRACEFUL BY CONTRACT: a failed
// read leaves the caller's fallback in place and a failed write is
// swallowed after the local state updates — a preference must never
// break the screen that reads it (Home falls back to its defaults:
// map expanded, session-only state).

import { useCallback, useEffect, useState } from "react";

export function usePreference<T>(key: string, fallback: T) {
  const [value, setValueState] = useState<T>(fallback);
  // False until the first read settles (success OR failure): callers
  // render their default while loading so a stored "collapsed" never
  // flashes the expanded layout into a collapse after paint, and a
  // stored value never gets overwritten by a premature write.
  const [loaded, setLoaded] = useState(false);
  // True only when the read actually returned a stored value (as
  // opposed to "no row yet"): lets callers reconcile device-local
  // mirrors against real picks without ever persisting a default.
  const [hasStoredValue, setHasStoredValue] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (typeof fetch !== "function") {
      const timer = setTimeout(() => {
        if (!cancelled) setLoaded(true);
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
    fetch(`/api/v1/preferences?key=${encodeURIComponent(key)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("preference read failed"))))
      .then((body: { value?: unknown }) => {
        if (cancelled) return;
        if (body.value !== null && body.value !== undefined) {
          setValueState(body.value as T);
          setHasStoredValue(true);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const setValue = useCallback(
    (next: T) => {
      setValueState(next);
      if (typeof fetch !== "function") return;
      fetch("/api/v1/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value: next }),
      }).catch(() => {
        // Session state already carries the choice; the stored
        // preference simply stays what it was. Never surface this.
      });
    },
    [key],
  );

  return { value, loaded, hasStoredValue, setValue };
}

/** Device-local mirror of the map collapse pick (V78 live-check
 *  instability fix, 2026-11-10): the server preference is the source
 *  of truth, but the hook previously had NO synchronous first-paint
 *  source — every mount rendered EXPANDED until the async read
 *  landed, so the block's state across plain reloads depended on
 *  fetch timing (observed live: collapsed -> expanded with no toggle
 *  touched). The mirror is the theme pattern (src/lib/theme.ts): it
 *  is written ONLY on an explicit toggle or when reconciling a real
 *  stored server value — never on the load path for a mere default,
 *  so a default is never persisted as if it were a pick. */
export const HOME_MAP_COLLAPSED_MIRROR_KEY = "trucking-home-map-collapsed";

function readMapMirror(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(HOME_MAP_COLLAPSED_MIRROR_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

function writeMapMirror(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HOME_MAP_COLLAPSED_MIRROR_KEY, collapsed ? "1" : "0");
  } catch {
    // Storage unavailable (private mode): the server preference and
    // session state still carry the pick.
  }
}

/** Home's map collapse choice: stored value shape { collapsed: boolean }. */
export function useHomeMapCollapsed() {
  const pref = usePreference<{ collapsed: boolean }>("home_map_collapsed", { collapsed: false });
  const serverCollapsed = pref.value?.collapsed === true;

  // Reconcile a stale mirror when the read lands WITH a real stored
  // value (e.g. the pick was made on another device, or by Abel):
  // the mirror is an external system (localStorage), so syncing it
  // is exactly what an effect is for.
  useEffect(() => {
    if (pref.loaded && pref.hasStoredValue) {
      writeMapMirror(serverCollapsed);
    }
  }, [pref.loaded, pref.hasStoredValue, serverCollapsed]);

  const setCollapsed = useCallback(
    (collapsed: boolean) => {
      writeMapMirror(collapsed);
      pref.setValue({ collapsed });
    },
    [pref],
  );

  // Before the read settles, the mirror (the last explicit toggle on
  // THIS device, read synchronously — it cannot change mid-mount)
  // decides; with no mirror, the shipped default (expanded). After
  // the read settles, the server value decides.
  const collapsed = pref.loaded ? serverCollapsed : (readMapMirror() ?? false);
  return { collapsed, loaded: pref.loaded, setCollapsed };
}
