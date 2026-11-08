"use client";

// Background tracking devices (docs/design/background-tracking.md, Path 2). The native Android shell
// reports the truck's position with the app closed; it proves who it is with a DEVICE TOKEN issued
// here. The secret is shown once, right after it is created, and can't be shown again - lose it and
// you revoke it and make another. A token can only post position fixes; revoking is instant.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { formatDateTime } from "@/lib/time";

// The tracker Android app ships as a GitHub release (tag tracker-v1.0.4); this stable
// /releases/download/ URL always serves that release's APK asset. When a new tracker
// version is published, bump the tag in BOTH places in this one line - this constant is
// the only place the download URL lives.
export const TRACKER_ANDROID_DOWNLOAD_URL =
  "https://github.com/abelsvj-afk/Trucking/releases/download/tracker-v1.0.4/trucking-os-tracker-v1.0.4.apk";

type Device = { id: string; label: string; created_at: string; last_used_at: string | null };

function lastSeen(iso: string | null): string {
  if (!iso) return "never used";
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return mins < 2 ? "reporting just now" : mins < 120 ? `last report ${mins} min ago` : `last report ${formatDateTime(iso, "America/New_York")}`;
}

export default function BackgroundTrackingSettings() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ label: string; token: string } | null>(null);

  const load = useCallback(() => {
    apiClient
      .deviceTokens()
      .then((r) => setDevices(r.data))
      .catch(() => setError("Couldn't load your tracking devices."));
  }, []);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.createDeviceToken(label.trim());
      setFresh({ label: r.data.label, token: r.data.token });
      setLabel("");
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't create the token.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await apiClient.revokeDeviceToken(id);
      load();
    } catch {
      setError("Couldn't revoke that device. Try again.");
    }
  }

  return (
    <section aria-label="Background tracking">
      <h2>Background tracking (works with the app closed)</h2>
      <p className="row-sub">
        The Trucking OS Tracker app on your Android phone keeps reporting where the truck is after you close this app, so
        your log can switch to Driving on its own. Each phone gets its own key. A key can only send position — nothing else.
      </p>

      <p className="row-sub">
        Don&apos;t have the Tracker app yet? It&apos;s the Android companion app that reports the truck&apos;s position with
        this app closed. Install it on the phone, then make a key below and paste it into the Tracker app. Installing it
        over an older Tracker copy keeps that copy&apos;s saved server address and key.
      </p>
      <p>
        <a role="button" href={TRACKER_ANDROID_DOWNLOAD_URL}>
          Download the tracker app (Android)
        </a>
      </p>
      <p className="row-sub">There is no iPhone version of the Tracker app yet.</p>

      {fresh && (
        <div role="status" className="hud-note">
          <p>
            <strong>Key for {fresh.label}</strong> — copy it into the Tracker app now. It is shown once and can&apos;t be shown
            again.
          </p>
          <input readOnly value={fresh.token} aria-label="Device key" onFocus={(e) => e.currentTarget.select()} style={{ width: "100%" }} />
          <p className="row-sub">Server address for the Tracker app: {typeof window !== "undefined" ? window.location.origin : ""}</p>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(fresh.token)}>Copy key</button>{" "}
          <button type="button" onClick={() => setFresh(null)}>Done — I&apos;ve saved it</button>
        </div>
      )}

      {error && <p role="alert">{error}</p>}
      {devices === null && !error && <p className="row-sub">Loading…</p>}
      {devices && devices.length === 0 && <p className="row-sub">No phone is set up for background tracking yet.</p>}
      {devices && devices.length > 0 && (
        <ul>
          {devices.map((d) => (
            <li key={d.id}>
              <span className="row-title">{d.label}</span> <span className="row-sub">· {lastSeen(d.last_used_at)}</span>{" "}
              <button type="button" onClick={() => void revoke(d.id)} aria-label={`Revoke ${d.label}`}>Revoke</button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={create}>
        <label htmlFor="device-label">Name this phone</label>
        <input id="device-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. My Android" maxLength={60} required />
        <button type="submit" disabled={busy || label.trim().length === 0}>
          {busy ? "Creating…" : "Make a key for this phone"}
        </button>
      </form>
    </section>
  );
}
