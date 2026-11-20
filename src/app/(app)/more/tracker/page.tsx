"use client";

// More → Tracker app (owner 2026-11-17: "there's nowhere to find a download in the app"). Since the Settings split
// (2026-11-12) the download sat inside Settings → Hours and truck with nothing saying so. This page is the one
// obvious place: download the current Android Tracker, the steps to set it up, and the device keys it needs.

import { useEffect, useState } from "react";
import PageHeader from "@/components/PageHeader";
import BackgroundTrackingSettings, { TRACKER_ANDROID_DOWNLOAD_URL, TRACKER_ANDROID_VERSION } from "@/components/settings/BackgroundTrackingSettings";
import { usePageTitle } from "@/lib/use-page-title";

export default function TrackerPage() {
  usePageTitle("Tracker app");
  const [server, setServer] = useState("");
  // The address to paste into the Tracker is this app's own address; read after mount (no window on the server).
  useEffect(() => {
    const id = window.setTimeout(() => setServer(window.location.origin), 0);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div className="tracker-page">
      <PageHeader
        title="Tracker app"
        purpose="The Android app that keeps reporting where the truck is with this app closed, so your log switches to Driving and back on its own."
      />
      <p>
        <a role="button" className="tracker-download" href={TRACKER_ANDROID_DOWNLOAD_URL} download>
          ⬇ Download the Tracker (Android, version {TRACKER_ANDROID_VERSION})
        </a>
      </p>
      <p className="row-sub">There is no iPhone version of the Tracker yet.</p>

      <section aria-label="Set it up">
        <h2>Set it up</h2>
        <ol className="tracker-steps">
          <li>
            <strong>Make a key</strong> below (name it after the phone) and copy it. It&apos;s shown once.
          </li>
          <li>
            <strong>Updating from an older Tracker (1.0.x)?</strong> Uninstall the old one first: phone Settings → Apps → Trucking OS
            Tracker → Uninstall. Android won&apos;t install this version over it.
          </li>
          <li>
            <strong>Install</strong> the file you downloaded (open it from your downloads; allow installs from this source if asked).
          </li>
          <li>
            Open the Tracker → <strong>Settings</strong>: paste the server address{server ? <> <code>{server}</code></> : null} and
            your key, then <strong>Save</strong>.
          </li>
          <li>
            Tap <strong>Start tracking</strong> and allow <strong>Location</strong> and <strong>Notifications</strong>.
          </li>
          <li>
            Phone Settings → Apps → Trucking OS Tracker → Battery → <strong>Unrestricted</strong>.
          </li>
          <li>
            Check your notification shade: <strong>&quot;Trucking OS Tracker&quot;</strong> stays there while it tracks, even
            with the app closed.
          </li>
        </ol>
      </section>

      <section aria-label="What changed in 1.3.0">
        <h2>What changed in 1.3.0</h2>
        <ul>
          <li>
            One bad position can no longer make the server throw away the whole batch: the Tracker resends that batch
            one position at a time, so only the bad one is skipped.
          </li>
          <li>
            Your key is no longer copied into phone backups. If you ever restore this phone or move to a new one, paste
            your key once in the Tracker&apos;s Settings.
          </li>
          <li>Updating from 1.2.0 installs right over it — your server address and key stay.</li>
        </ul>
      </section>

      <section aria-label="The map in the Tracker">
        <h2>The map while you drive (1.2.0)</h2>
        <ul>
          <li>
            In the Tracker, tap <strong>Open the map</strong>. It keeps the screen on, and the first time you open it, log in
            to the app there.
          </li>
          <li>
            Press <strong>Home</strong> (or switch apps) and the map floats small over everything. Drag it anywhere, pinch to
            resize, tap it to bring it back full size.
          </li>
          <li>
            If it closes instead of floating: phone Settings → Apps → Trucking OS Tracker → Picture-in-picture →{" "}
            <strong>Allowed</strong>.
          </li>
          <li>The floating hours clock can now be dragged anywhere too.</li>
          <li>Updating from 1.1.x installs right over it — no uninstall, your server address and key stay.</li>
        </ul>
      </section>

      <BackgroundTrackingSettings keysOnly />
    </div>
  );
}
