"use client";

// Live position on Home (docs/design/driver-hud.md §8): a compact map that
// follows the phone, shown ONLY while a recent GPS fix exists - otherwise
// the card is absent (never a blank map or a guessed location). It says
// how accurate and how fresh the fix is. It is where the PHONE is, not an
// ELD engine position. Map tiles come from OpenStreetMap, the same as
// Smart Path / Drive (the tile server sees which tiles are requested).

import dynamic from "next/dynamic";
import Link from "next/link";
import { useNowTick } from "@/lib/use-now-tick";
import type { VehiclePosition } from "@/lib/use-vehicle-motion";

const DriveMap = dynamic(() => import("@/components/DriveMap"), { ssr: false });

/** A fix older than this is not "live": the card disappears rather than mislead. */
export const POSITION_FRESH_MS = 60_000;

export function positionAgeText(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  return s < 5 ? "just now" : s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}

export default function HomePositionCard({ position }: { position: VehiclePosition | null }) {
  const nowMs = useNowTick(5_000);
  if (!position) return null;
  const age = nowMs - position.atMs;
  if (age > POSITION_FRESH_MS) return null;

  return (
    <section aria-label="Where you are" className="home-position">
      <DriveMap
        geometry={[]}
        deadheadGeometry={[]}
        stops={[]}
        stopStatus={[]}
        position={{ lat: position.lat, lng: position.lng }}
        headingDeg={null}
        positionQuality={null}
        follow
        onUserPan={() => {}}
        night={false}
        height="22vh"
      />
      <p className="row-sub">
        Phone GPS · ±{Math.round(position.accuracyM)} m · {positionAgeText(age)} ·{" "}
        <Link href="/smart-path">Plan a route</Link>
      </p>
    </section>
  );
}
