// Fleet tab index. Per docs/design/ui-ux.md, Fleet's own sections
// (Trucks/Trailers/Drivers/Maintenance) are reached via a segmented
// control at the top of this tab - links added here as each lands
// (tasks 3.1-3.3, 3.9), not built ahead of what exists.
//
// A Server Component (no "use client"), so it uses Next's own `metadata`
// export for a distinct <title> (WCAG 2.4.2) rather than the
// usePageTitle() client hook every data-fetching screen uses instead.
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Fleet — Trucking OS" };

export default function FleetPage() {
  return (
    <div>
      <h1>Fleet</h1>
      <ul>
        <li>
          <Link href="/fleet/trucks">Trucks</Link>
        </li>
        <li>
          <Link href="/fleet/trailers">Trailers</Link>
        </li>
        <li>
          <Link href="/fleet/drivers">Drivers</Link>
        </li>
        <li>
          <Link href="/fleet/maintenance-events">Maintenance</Link>
        </li>
        <li>
          <Link href="/fleet/maintenance-schedule">Maintenance schedule</Link>
        </li>
        <li>
          <Link href="/fleet/equipment-checklist">Equipment checklist</Link>
        </li>
        <li>
          <Link href="/fleet/pretrip-inspections">Pre-trip inspections</Link>
        </li>
      </ul>
    </div>
  );
}
