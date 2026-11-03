"use client";

// Registers the app-shell service worker (public/sw.js) in
// production only. Installability only - the worker caches
// immutable static assets, never pages or API responses, and
// never touches location (see sw.js). Registration failures are
// silent: the app must work identically without it.

import { useEffect } from "react";

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // No worker, no problem - the app is fully usable without it.
    });
  }, []);
  return null;
}
