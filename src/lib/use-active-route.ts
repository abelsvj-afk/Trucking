"use client";

// The planned route for the ACTIVE trip, for Home's mini map (Block C). The route lives where
// Smart Path saved it (the checked run, localStorage). It is drawn only if that run belongs to a
// load that is still confirmed (not done, cancelled or deleted) and is not stale; otherwise
// there is no route and the map shows position + heading only - never an old or invented line.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { apiClient } from "@/lib/api-client";
import { buildDrivePlan } from "@/lib/drive";
import { ACTIVE_PLAN_STORAGE_KEY, parseActivePlan } from "@/lib/drive-review";
import type { LatLng } from "@/lib/smart-path";
import type { Load } from "@/types/entities";

/** A checked run older than this is a different trip. */
export const ROUTE_MAX_AGE_MS = 72 * 3_600_000;

export interface ActiveRoute {
  loadId: string;
  geometry: LatLng[];
  destinationLabel: string;
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_PLAN_STORAGE_KEY);
  } catch {
    return null;
  }
}
const subscribeNoop = () => () => {};

/** Pure: the route to draw, or null. `loadStatus` is the plan's load as the server knows it (null = unknown/absent). */
export function chooseActiveRoute(
  raw: string | null,
  nowMs: number,
  loadStatus: string | null,
): ActiveRoute | null {
  const stored = parseActivePlan(raw);
  if (!stored) return null;
  if (nowMs - stored.savedAtMs > ROUTE_MAX_AGE_MS) return null;
  if (loadStatus !== "confirmed") return null;
  const plan = buildDrivePlan(stored.result, new Date(stored.savedAtMs));
  if (plan.geometry.length < 2) return null;
  return { loadId: plan.loadId, geometry: plan.geometry, destinationLabel: plan.destinationLabel };
}

export function useActiveRoute(): ActiveRoute | null {
  const raw = useSyncExternalStore(subscribeNoop, readRaw, () => null);
  const loadId = useMemo(() => parseActivePlan(raw)?.result.load.id ?? null, [raw]);
  const [status, setStatus] = useState<{ loadId: string; status: string | null } | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) setNowMs(Date.now());
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loadId) return;
    let cancelled = false;
    apiClient
      .list<Load>("loads", { limit: "200" })
      .then((res) => {
        if (cancelled) return;
        const load = res.data.find((l) => l.id === loadId && !l.deleted_at);
        setStatus({ loadId, status: load?.status ?? null });
      })
      .catch(() => {
        if (!cancelled) setStatus({ loadId, status: null });
      });
    return () => {
      cancelled = true;
    };
  }, [loadId]);

  return useMemo(
    () => (nowMs === null || !loadId || status?.loadId !== loadId ? null : chooseActiveRoute(raw, nowMs, status.status)),
    [raw, nowMs, loadId, status],
  );
}
