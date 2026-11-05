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

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { apiClient } from "@/lib/api-client";
import { useHosWindow } from "@/lib/use-hos-window";
import { useVehicleMotionDetail } from "@/lib/use-vehicle-motion";
import { decideLock, type DutyKnowledge } from "@/lib/motion-lock-policy";
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
  const forms = Array.from(root.querySelectorAll("form"));
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

function Watcher() {
  const { state: motion, speedMph } = useVehicleMotionDetail();
  const { state: hos, refresh } = useHosWindow();
  // The latest logged status (rows come ascending). No rows / not loaded / error: unknown -> the lock stays.
  const duty: DutyKnowledge =
    hos.status === "loaded" && hos.data.length > 0 ? hos.data[hos.data.length - 1]!.duty_status : "unknown";
  const decision = decideLock(motion, duty, speedMph);
  const locked = decision.kind === "lock";
  const mismatchStatus = decision.kind === "mismatch" ? decision.status : null;
  const pathname = usePathname();
  // Dismissed prompt -> slim persistent banner; forgotten once the mismatch ends.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

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

  async function switchToDriving() {
    setSwitching(true);
    setSwitchError(null);
    try {
      await apiClient.create("duty-logs", { duty_status: "driving", started_at: new Date().toISOString() });
      refresh(); // the status becomes Driving -> the lock engages
    } catch {
      setSwitchError("Couldn't switch your status. Try again.");
    } finally {
      setSwitching(false);
    }
  }

  if (locked) {
    return (
      <p role="status" className="motion-lock-banner">
        You&apos;re moving — forms and editing are locked until you stop. Reading is still on.
      </p>
    );
  }
  if (mismatchStatus) {
    const label = STATUS_WORDS[mismatchStatus];
    if (dismissedFor === mismatchStatus) {
      return (
        <p role="status" className="motion-lock-banner motion-lock-slim">
          Truck is moving; your log says {label}.{" "}
          <button type="button" onClick={() => setDismissedFor(null)}>Review</button>
        </p>
      );
    }
    return (
      <div role="alert" className="motion-lock-banner">
        <p>The truck is moving, but your status says <strong>{label}</strong>. Switch to Driving?</p>
        <button type="button" onClick={() => void switchToDriving()} disabled={switching}>
          {switching ? "Switching…" : "Switch to Driving"}
        </button>{" "}
        <button type="button" onClick={() => setDismissedFor(mismatchStatus)}>Not now</button>
        {switchError && <p role="alert">{switchError}</p>}
      </div>
    );
  }
  return null;
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
