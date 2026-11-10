// Fleet tab index. Per docs/design/ui-ux.md, Fleet's own sections
// (Trucks/Trailers/Drivers/Maintenance) are reached via a segmented
// control at the top of this tab - links added here as each lands
// (tasks 3.1-3.3, 3.9), not built ahead of what exists.
//
// UI/UX upgrade: every entry carries its one-line "what is this for",
// so the hub teaches instead of listing bare names.
//
// A Server Component (no "use client"), so it uses Next's own `metadata`
// export for a distinct <title> (WCAG 2.4.2) rather than the
// usePageTitle() client hook every data-fetching screen uses instead.
import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import HubRow from "@/components/HubRow";
import Reveal from "@/components/Reveal";

export const metadata: Metadata = { title: "Fleet — Road to Legacy" };

const SECTIONS: { href: string; label: string; desc: string }[] = [
  { href: "/fleet/trucks", label: "Trucks", desc: "Your trucks — type, photo, size, and status." },
  { href: "/fleet/trailers", label: "Trailers", desc: "The trailers you pull, and what kind each is." },
  { href: "/fleet/drivers", label: "Drivers", desc: "Driver profiles — contact, CDL, assigned truck." },
  { href: "/fleet/hos", label: "Day log", desc: "Your duty clocks — hours of service. Track your hours so you never run illegal." },
  { href: "/fleet/pretrip-inspections", label: "Pre-trip inspections", desc: "The walk-around before you roll — defects logged, not remembered." },
  { href: "/fleet/checklists", label: "Checklists", desc: "Coupling, docking, and paperwork, step by step." },
  { href: "/fleet/maintenance-events", label: "Maintenance", desc: "Every repair and service, and what it cost." },
  { href: "/fleet/maintenance-schedule", label: "Maintenance schedule", desc: "What's coming due before it becomes a breakdown." },
  { href: "/fleet/equipment-checklist", label: "Equipment checklist", desc: "The gear that should be on board — checked, not guessed." },
  { href: "/fleet/truck-profile", label: "Truck profile", desc: "Size, speed, and cab appliances — Smart Path plans from this." },
];

export default function FleetPage() {
  return (
    <div>
      <PageHeader title="Fleet" purpose="Your trucks, trailers, drivers, and hours — the physical side of the business." />
      <ul>
        {SECTIONS.map((section, i) => (
          <Reveal as="li" key={section.href} index={i}>
            <HubRow href={section.href} label={section.label} desc={section.desc} />
          </Reveal>
        ))}
      </ul>
    </div>
  );
}
