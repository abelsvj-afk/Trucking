// The 3D driving view, shared by every driving surface (Home + Drive):
// one toggle, one preference. The driving map is 3D — tilted, heading-up,
// truck at the bottom — unless he turned it off. "0" = flat top-down.
//
// The preference lives in localStorage because the map choice is his, not
// the app's: the Drive toggle and the Home map must never disagree about
// it, which is exactly what happened when the Drive page owned the key
// alone and Home rendered flat by default.

import { useCallback, useEffect, useState } from "react";

/** 3D driving view (owner 2026-11-17): tilted perspective, 3D truck at the bottom. "0" = flat top-down. */
export const DRIVE_3D_VIEW_STORAGE_KEY = "trucking.smartpath.drive-3d-view.v1";

/** The stored 3D choice; default ON — the driving map is 3D unless he turned it off. */
export function readDrive3dView(): boolean {
  try {
    return window.localStorage.getItem(DRIVE_3D_VIEW_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeDrive3dView(next: boolean): void {
  try {
    window.localStorage.setItem(DRIVE_3D_VIEW_STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Storage full/blocked: the map keeps working; the preference is a
    // nicety, never a reason to fail the surface.
  }
}

/** The 3D choice for the driving surfaces. Reads the stored value on mount. */
export function useDrive3dView(): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [view3d, setView3dState] = useState(true);
  useEffect(() => {
    let cancelled = false;
    // The read hits an external system (localStorage) on mount; state
    // lands a microtask later, the React-endorsed shape for mount-time
    // external reads (and this repo's lint rule).
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setView3dState(readDrive3dView());
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const setView3d = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setView3dState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      writeDrive3dView(value);
      return value;
    });
  }, []);
  return [view3d, setView3d];
}
