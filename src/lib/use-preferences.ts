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
        if (body.value !== null && body.value !== undefined) setValueState(body.value as T);
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

  return { value, loaded, setValue };
}

/** Home's map collapse choice: stored value shape { collapsed: boolean }. */
export function useHomeMapCollapsed() {
  const { value, loaded, setValue } = usePreference<{ collapsed: boolean }>("home_map_collapsed", {
    collapsed: false,
  });
  const setCollapsed = useCallback((collapsed: boolean) => setValue({ collapsed }), [setValue]);
  return { collapsed: value?.collapsed === true, loaded, setCollapsed };
}
