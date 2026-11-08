// Home display preference: the "This month" business financial
// summary block (owner order 2026-11-07).
//
// That block is the FUTURE company view - operational revenue,
// expenses and operating result for money running through his own
// company. While his income is driver pay (shown in the Driver Pay
// section above it), the block reads as a row of zeros that means
// nothing, so it is HIDDEN BY DEFAULT and toggleable: the owner can
// switch it on in Settings when company money starts flowing, and it
// then renders exactly as before. Same device-local pattern as the
// theme choice (src/lib/theme.ts): a localStorage pick read through
// useSyncExternalStore, with the shipped default as the server
// snapshot so hydration agrees and the block never flashes on.
//
// Display only: no summary data or calculation reads this flag.

import { useSyncExternalStore } from "react";

export const HOME_BUSINESS_SUMMARY_STORAGE_KEY = "trucking-home-business-summary";

/** Shipped default: hidden. Flip here if the default ever changes. */
export const HOME_BUSINESS_SUMMARY_DEFAULT = false;

/** Pure: only the explicit stored "on" shows the block; missing or
 *  garbage values resolve to the shipped default (hidden). */
export function resolveShowBusinessSummary(stored: string | null | undefined): boolean {
  if (stored === "on") return true;
  if (stored === "off") return false;
  return HOME_BUSINESS_SUMMARY_DEFAULT;
}

/** Persist the pick (browser only; storage failures are non-fatal,
 *  matching applyThemeChoice - the pick still applies this session
 *  via the caller's own state). */
export function storeShowBusinessSummary(show: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HOME_BUSINESS_SUMMARY_STORAGE_KEY, show ? "on" : "off");
  } catch {
    // Storage can be unavailable (private mode); the Settings
    // control's own state still reflects the pick for this session.
  }
  // useSyncExternalStore subscribers in this window only re-read on
  // the "storage" event, which the browser fires for OTHER windows;
  // dispatch one so a mounted Home (or Settings) updates immediately.
  window.dispatchEvent(new StorageEvent("storage", { key: HOME_BUSINESS_SUMMARY_STORAGE_KEY }));
}

function subscribeToBusinessSummary(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** Reactively read the pick; false (hidden) on the server and until
 *  the stored value is read, so the default is hidden everywhere. */
export function useShowBusinessSummary(): boolean {
  const stored = useSyncExternalStore(
    subscribeToBusinessSummary,
    () => window.localStorage.getItem(HOME_BUSINESS_SUMMARY_STORAGE_KEY),
    () => null,
  );
  return resolveShowBusinessSummary(stored);
}
