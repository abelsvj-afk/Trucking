"use client";

// First-run location prompt (owner decision D-7, 2026-11-05). The driving lock,
// the hours/stop checks and Drive all need location, but the app-wide lock
// does nothing without permission (it never triggers the browser's own prompt
// on ordinary pages). This asks ONCE, in plain words, why - then never again
// (the choice is remembered on this phone). Declining is fine: the app works,
// the lock just cannot know he is moving, and says so where it matters.

import { useEffect, useState } from "react";

const ASKED_KEY = "trucking.location-asked.v1";

function readAsked(): boolean {
  try {
    return window.localStorage.getItem(ASKED_KEY) !== null;
  } catch {
    return true; // storage blocked: never nag
  }
}
function markAsked(value: string): void {
  try {
    window.localStorage.setItem(ASKED_KEY, value);
  } catch {
    // Nothing to do - without storage we simply may ask again next visit.
  }
}

export default function LocationPrompt() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator) || !navigator.permissions?.query) return;
    if (readAsked()) return;
    let cancelled = false;
    navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((status) => {
        // Only when the browser would actually ask; granted or denied needs no explanation here.
        if (!cancelled && status.state === "prompt") setShow(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  const allow = () => {
    markAsked("allowed-asked");
    setShow(false);
    navigator.geolocation.getCurrentPosition(
      () => {},
      () => {},
      { timeout: 15_000 },
    );
  };
  const later = () => {
    markAsked("declined");
    setShow(false);
  };

  return (
    <section role="dialog" aria-modal="false" aria-label="Allow location" className="location-prompt">
      <h2>Let the app know when you&apos;re driving?</h2>
      <p>
        With location on, the app locks forms while you&apos;re moving and unlocks them when you&apos;re parked, and
        Drive can follow your route. It uses your position only to make those decisions on this phone — nothing
        is stored from this.
      </p>
      <p>Without it everything still works, but the app can&apos;t tell when you&apos;re moving.</p>
      <button type="button" onClick={allow}>Allow location</button>{" "}
      <button type="button" onClick={later}>Not now</button>
    </section>
  );
}
