"use client";

// Read side of the live layer. Outside a LiveDataProvider (tests,
// /login) every version is 0 and connected is false: hooks behave
// exactly as before - fetch once - and nothing claims to be live.

import { useContext } from "react";
import { LiveContext } from "@/components/live/LiveDataProvider";
import type { LiveTable } from "./live-tables";

/** A number that changes whenever any of the given tables changes. */
export function useLiveVersion(tables: readonly (LiveTable | null)[]): number {
  const { versions } = useContext(LiveContext);
  let sum = 0;
  for (const t of tables) if (t) sum += versions[t];
  return sum;
}

export function useLiveConnected(): boolean {
  return useContext(LiveContext).connected;
}
