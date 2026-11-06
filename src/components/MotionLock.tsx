"use client";

// App-wide driving lock (audit A6, docs/design/driver-usability.md §1).
// While the phone positively reports the truck moving (and the stop has
// not yet settled), every form in the app is made inert - no typing, no
// submit - and a banner says why. Reading is never blocked.
//
// It only watches GPS when location permission is ALREADY granted for the
// site (read through the Permissions API); it never triggers a prompt on
// ordinary pages. Without permission it does nothing (the HUD and Drive
// keep their own stricter, fail-closed rules). Unknown speed does NOT
// lock here, because a page-wide lock can't ask "are you parked?" - that
// question lives where an action is taken (HUD status change, Drive).

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { apiClient } from "@/lib/api-client";
import { useHosWindow } from "@/lib/use-hos-window";
import { useVehicleMotionDetail } from "@/lib/use-vehicle-motion";
import { decideLock, type DutyKnowledge } from "@/lib/motion-lock-policy";
import { decideAuto } from "@/lib/auto-switch";
import { useNowTick } from "@/lib/use-now-tick";
import type { DutyStatus } from "@/types/entities";

const STATUS_WORDS: Record<Exclude<DutyStatus, "driving">, string> = {
  on_duty: "On duty (not driving)",
  off_duty: "Off duty",
  sleeper: "Sleeper",
};

/**
 * Make every form inside `root` inert / restore them - AND every editable
 * control that sits OUTSIDE a form (audit Wave 4 / SAF-1: the paper-log
 * segment editor, the day-edit panel, memory editing and photo pickers are not
 * wrapped in <form>, so locking forms alone left them live while moving).
 * A control or region marked `data-motion-exempt` is left alone: the AI kill
 * switches stay reachable (turning authority off is a safety action and
 * revocation must always work). Returns how many forms it touched.
 */
export function setFormsInert(root: ParentNode, inert: boolean): number {
  // The duty-status switcher (Block A) is exempt permanently: a form - not just a loose control -
  // marked data-motion-exempt, or inside a region marked so, is never locked.
  const forms = Array.from(root.querySelectorAll("form")).filter((f) => !f.closest("[data-motion-exempt]"));
  const loose = Array.from(root.querySelectorAll("input, select, textarea")).filter(
    (el) => !el.closest("form") && !el.closest("[data-motion-exempt]"),
  );
  for (const el of [...forms, ...loose]) {
    if (inert) {
      // Already inert for another reason (or inside something that is): not
      // ours to lock - and so not ours to unlock later.
      if (el.hasAttribute("inert") || el.closest("[inert]")) continue;
      el.setAttribute("inert", "");
      el.setAttribute("data-motion-locked", "true");
    } else if (el.getAttribute("data-motion-locked") === "true") {
      el.removeAttribute("inert");
      el.removeAttribute("data-motion-locked");
    }
  }
  // Restoring must also find locked controls that have since left their form's scope.
  if (!inert) {
    for (const el of Array.from(root.querySelectorAll('[data-motion-locked="true"]'))) {
      el.removeAttribute("inert");
      el.removeAttribute("data-motion-locked");
    }
  }
  return forms.length;
}

function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

interface AutoAttempt {
  key: number;
  tries: number;
  inFlight: boolean;
  done: boolean;
}
const MAX_AUTO_TRIES = 4;

function Watcher() {
  const { state: motion, speedMph, sustained } = useVehicleMotionDetail();
  const { state: hos, refresh } = useHosWindow();
  const nowMs = useNowTick(5_000);
  // The latest logged status (rows come ascending). No rows / not loaded / error: unknown -> the lock stays.
  const duty: DutyKnowledge =
    hos.status === "loaded" && hos.data.length > 0 ? hos.data[hos.data.length - 1]!.duty_status : "unknown";
  const decision = decideLock(motion, duty, speedMph);
  const locked = decision.kind === "lock";
  const mismatchStatus = decision.kind === "mismatch" ? decision.status : null;
  const latestRowStartedMs =
    hos.status === "loaded" && hos.data.length > 0 ? Date.parse(hos.data[hos.data.length - 1]!.started_at) : null;
  const auto = decideAuto(duty, sustained, nowMs, Number.isFinite(latestRowStartedMs) ? latestRowStartedMs : null);
  const pathname = usePathname();
  // Dismissed prompt -> slim persistent banner; forgotten once the mismatch ends.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [autoNotice, setAutoNotice] = useState<string | null>(null);
  const [stationaryDismissedFor, setStationaryDismissedFor] = useState<number | null>(null);
  const attempt = useRef<AutoAttempt | null>(null);

  // Derived reset (React's "adjust state during render" pattern): once the mismatch ends, forget the dismissal.
  if (mismatchStatus === null && dismissedFor !== null) setDismissedFor(null);

  useEffect(() => {
    const main = document.getElementById("main-content");
    if (!main) return;
    setFormsInert(main, locked);
    if (!locked) return;
    // Forms that mount while locked (a new page, a sheet) are locked too.
    const observer = new MutationObserver(() => setFormsInert(main, true));
    observer.observe(main, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      setFormsInert(main, false);
    };
  }, [locked, pathname]);

  // Block A: the automatic switch to Driving. The server decides whether it may (a manual change that won
  // the race, or an already-Driving log, makes it stand down); a failed call retries a few times, never loops.
  const autoKey = auto.kind === "auto_switch" ? auto.detectedAtMs : null;
  useEffect(() => {
    if (autoKey === null) return;
    const cur = attempt.current && attempt.current.key === autoKey ? attempt.current : { key: autoKey, tries: 0, inFlight: false, done: false };
    attempt.current = cur;
    if (cur.done || cur.inFlight || cur.tries >= MAX_AUTO_TRIES) return;
    cur.inFlight = true;
    cur.tries += 1;
    apiClient
      .autoMotionSwitch(new Date(autoKey).toISOString(), autoSubmissionId(autoKey))
      .then((res) => {
        cur.done = true;
        if (res.data.switched && !res.data.deduplicated) {
          setAutoNotice(`Switched to Driving at ${clockLabel(Date.parse(res.data.startedAt ?? new Date(autoKey).toISOString()))} — truck moving.`);
        }
        refresh();
      })
      .catch(() => {
        // Retried on the next tick (up to MAX_AUTO_TRIES); the manual prompt stays on screen meanwhile.
      })
      .finally(() => {
        cur.inFlight = false;
      });
  }, [autoKey, nowMs, refresh]);

  async function logStatus(status: DutyStatus) {
    setSwitching(true);
    setSwitchError(null);
    try {
      await apiClient.create("duty-logs", { duty_status: status, started_at: new Date().toISOString(), submission_id: crypto.randomUUID() });
      refresh();
    } catch {
      setSwitchError("Couldn't switch your status. Try again.");
    } finally {
      setSwitching(false);
    }
  }
  const switchToDriving = () => logStatus("driving");

  const notice = autoNotice ? (
    <div role="status" className="motion-lock-banner" data-motion-exempt>
      <p>{autoNotice} Wrong? Change your status on Home.</p>
      <button type="button" onClick={() => setAutoNotice(null)}>OK</button>
    </div>
  ) : null;

  if (locked) {
    return (
      <>
        {notice}
        <div role="status" className="motion-lock-banner" data-motion-exempt>
          <p>You&apos;re moving — forms and editing are locked until you stop. Reading is still on.</p>
          {duty !== "driving" && (
            <>
              <p>Your log doesn&apos;t say Driving.</p>
              <button type="button" onClick={() => void switchToDriving()} disabled={switching}>
                {switching ? "Switching…" : "Switch to Driving"}
              </button>
              {switchError && <p role="alert">{switchError}</p>}
            </>
          )}
        </div>
      </>
    );
  }
  if (auto.kind === "still_driving_prompt" && stationaryDismissedFor !== sustained.stoppedSinceMs) {
    return (
      <>
        {notice}
        <div role="alert" className="motion-lock-banner" data-motion-exempt>
          <p>You&apos;ve been stopped for 5 minutes but your log says <strong>Driving</strong>. Still driving?</p>
          <button type="button" onClick={() => void logStatus("on_duty")} disabled={switching}>On duty (not driving)</button>{" "}
          <button type="button" onClick={() => void logStatus("off_duty")} disabled={switching}>Off duty</button>{" "}
          <button type="button" onClick={() => setStationaryDismissedFor(sustained.stoppedSinceMs)}>Still driving</button>
          {switchError && <p role="alert">{switchError}</p>}
        </div>
      </>
    );
  }
  if (mismatchStatus) {
    const label = STATUS_WORDS[mismatchStatus];
    if (dismissedFor === mismatchStatus && auto.kind !== "detected") {
      return (
        <>
          {notice}
          <p role="status" className="motion-lock-banner motion-lock-slim" data-motion-exempt>
            Truck is moving; your log says {label}.{" "}
            <button type="button" onClick={() => setDismissedFor(null)}>Review</button>
          </p>
        </>
      );
    }
    return (
      <>
        {notice}
        <div role="alert" className="motion-lock-banner" data-motion-exempt>
          <p>The truck is moving, but your status says <strong>{label}</strong>. Switch to Driving?</p>
          {auto.kind === "detected" && (
            <p>Still moving — I&apos;ll switch you to Driving automatically in about {Math.max(1, Math.round((auto.autoSwitchAtMs - nowMs) / 1000))} seconds.</p>
          )}
          <button type="button" onClick={() => void switchToDriving()} disabled={switching}>
            {switching ? "Switching…" : "Switch to Driving"}
          </button>{" "}
          <button type="button" onClick={() => setDismissedFor(mismatchStatus)}>Not now</button>
          {switchError && <p role="alert">{switchError}</p>}
        </div>
      </>
    );
  }
  return notice;
}

/** One stable id per detection, so a retry or a second tab replays the same switch instead of adding another. */
function autoSubmissionId(detectedAtMs: number): string {
  const hex = detectedAtMs.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${hex}`;
}

export default function MotionLock() {
  const [granted, setGranted] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return;
    let status: PermissionStatus | null = null;
    let cancelled = false;
    navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((result) => {
        if (cancelled) return;
        status = result;
        setGranted(result.state === "granted");
        result.onchange = () => setGranted(result.state === "granted");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (status) status.onchange = null;
    };
  }, []);

  return granted ? <Watcher /> : null;
}
