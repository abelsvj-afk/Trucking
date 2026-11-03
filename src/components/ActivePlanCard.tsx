"use client";

// Home's active-plan card (Drive Mode D1 scope): if a run was
// checked on Smart Path, Home offers GO; if a Drive trip was
// checkpointed mid-run (G-5), Home offers Resume. Reads only
// localStorage - the plan and checkpoint live on the device, and
// the card renders nothing at all when neither exists.

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  ACTIVE_PLAN_STORAGE_KEY,
  DRIVE_CHECKPOINT_STORAGE_KEY,
  buildDrivePlan,
  parseActivePlan,
  parseCheckpoint,
  type DrivePlanSnapshot,
} from "@/lib/drive";

function subscribeNoop(): () => void {
  return () => {};
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function serverSnapshot(): null {
  return null;
}

interface CardState {
  plan: DrivePlanSnapshot;
  resuming: boolean;
}

export default function ActivePlanCard() {
  // localStorage is an external store: useSyncExternalStore is
  // the React shape for reading it without hydration mismatches.
  const checkpointRaw = useSyncExternalStore(
    subscribeNoop,
    () => readRaw(DRIVE_CHECKPOINT_STORAGE_KEY),
    serverSnapshot,
  );
  const planRaw = useSyncExternalStore(
    subscribeNoop,
    () => readRaw(ACTIVE_PLAN_STORAGE_KEY),
    serverSnapshot,
  );

  // The checkpoint's 12-hour line needs a clock; it arrives with
  // the mount read (state set a microtask after mount - the shape
  // this repo's lint wants for external-system reads).
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

  const card = useMemo<CardState | null>(() => {
    if (nowMs === null) return null;
    const checkpoint = parseCheckpoint(checkpointRaw, nowMs);
    if (checkpoint) return { plan: checkpoint.plan, resuming: true };
    const active = parseActivePlan(planRaw);
    if (active) {
      return {
        plan: buildDrivePlan(active.result, new Date(active.savedAtMs)),
        resuming: false,
      };
    }
    return null;
  }, [checkpointRaw, planRaw, nowMs]);

  if (!card) return null;
  const { plan, resuming } = card;

  return (
    <section aria-label="Your checked run">
      <h2>{resuming ? "You're mid-run" : "Your checked run"}</h2>
      <p>
        {plan.originLabel} → {plan.destinationLabel}
        {resuming ? " — Drive paused with the run saved." : " — checked and ready to drive."}
      </p>
      {plan.truckLegal ? (
        <Link href="/smart-path/drive" className="page-action">
          {resuming ? "Resume Drive" : "GO — Drive this run"}
        </Link>
      ) : (
        <p>
          That check came back as a car route, so Drive can&apos;t take it.{" "}
          <Link href="/smart-path">Re-check the run</Link>
        </p>
      )}
    </section>
  );
}
