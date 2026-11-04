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
import { useVehicleMotion } from "@/lib/use-vehicle-motion";

/** Make every form inside `root` inert / restore them. Returns how many were touched. */
export function setFormsInert(root: ParentNode, inert: boolean): number {
  const forms = Array.from(root.querySelectorAll("form"));
  for (const form of forms) {
    if (inert) {
      // Already inert for another reason: not ours to lock - and so not
      // ours to unlock later.
      if (form.hasAttribute("inert")) continue;
      form.setAttribute("inert", "");
      form.setAttribute("data-motion-locked", "true");
    } else if (form.getAttribute("data-motion-locked") === "true") {
      form.removeAttribute("inert");
      form.removeAttribute("data-motion-locked");
    }
  }
  return forms.length;
}

function Watcher() {
  const motion = useVehicleMotion();
  const moving = motion === "moving";
  const pathname = usePathname();

  useEffect(() => {
    const main = document.getElementById("main-content");
    if (!main) return;
    setFormsInert(main, moving);
    if (!moving) return;
    // Forms that mount while moving (a new page, a sheet) are locked too.
    const observer = new MutationObserver(() => setFormsInert(main, true));
    observer.observe(main, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      setFormsInert(main, false);
    };
  }, [moving, pathname]);

  if (!moving) return null;
  return (
    <p role="status" className="motion-lock-banner">
      You&apos;re moving — forms and editing are locked until you stop. Reading is still on.
    </p>
  );
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
