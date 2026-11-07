// More tab index, per docs/design/ui-ux.md. Customers/Brokers land here
// now (tasks 3.4-3.5); Documents and Account/Settings (incl. future AI
// kill switches, per docs/governance.md) land as their own tasks.
//
// UI/UX upgrade: the Assistant leads the tab (it's the front door to
// the AI, not the seventh item in a list), and every entry carries its
// one-line purpose.
//
// A Server Component (no "use client"), so it uses Next's own `metadata`
// export for a distinct <title> (WCAG 2.4.2) rather than the
// usePageTitle() client hook every data-fetching screen uses instead.
import Link from "next/link";
import type { Metadata } from "next";
import { ChevronRight } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import Reveal from "@/components/Reveal";

export const metadata: Metadata = { title: "More — Road to Legacy" };

const SECTIONS: { href: string; label: string; desc: string }[] = [
  // Fleet reachability under the parked nav default (src/lib/nav-config.ts,
  // decision (a)): Fleet lost its bottom tab to Smart Path/Assistant, so
  // its hub door sits at the TOP of More — one tap from this hub.
  { href: "/fleet", label: "Fleet", desc: "Your trucks, trailers, drivers, and hours — the physical side of the business." },
  { href: "/more/assistant", label: "Assistant", desc: "King — ask anything, log anything, paste a whole dispatch thread or settlement." },
  { href: "/more/dispatch", label: "Dispatch helper", desc: "Paste a dispatch message; get a translation, a read on it, and reply drafts in English and Spanish." },
  { href: "/smart-path", label: "Smart Path", desc: "Map and route check — can you legally make this run, and where do fuel and food fit?" },
  { href: "/more/documents", label: "Documents", desc: "BOLs, permits, and photos, filed against the record they belong to." },
  { href: "/more/customers", label: "Customers", desc: "The shippers you haul for." },
  { href: "/more/brokers", label: "Brokers", desc: "The brokers you book through — MC numbers and contacts." },
  { href: "/more/credentials", label: "Credentials", desc: "CDL, medical card, inspection, registration, insurance — with the days left on each." },
  { href: "/more/facilities", label: "Facilities", desc: "The places you run to — check-in, parking, and detention, remembered per place." },
  { href: "/more/industry-intelligence", label: "Industry intelligence", desc: "Briefings on fuel, rules, and the market that affect your lanes." },
  { href: "/more/research", label: "Research", desc: "Deep research engine — watches fuel, rules & news; briefs you when pressure hits." },
  { href: "/more/game-plan", label: "Game Plan", desc: "Your target, gamed: the path from your real numbers to the truck, the authority, the company — projections, not promises." },
  { href: "/more/inbox", label: "Company inbox", desc: "Mail to dispatch@ that Abel has read — load offers, payments, shipper notes. Read-only; he cannot send or change anything." },
  { href: "/more/memories", label: "What Abel remembers", desc: "Everything the assistant has stored about you and your business — see it, correct it, delete it." },
  { href: "/more/settings", label: "Account & settings", desc: "Your account, and the switches for what the AI may do." },
];

export default function MorePage() {
  return (
    <div>
      <PageHeader title="More" purpose="The assistant, your paperwork, your contacts, and your settings." />
      <ul>
        {SECTIONS.map((section, i) => (
          <Reveal as="li" key={section.href} index={i}>
            <Link href={section.href} className="hub-row-link">
              <span className="hub-link">
                {section.label}
                <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" className="hub-chevron" />
              </span>
              <span className="hub-desc">{section.desc}</span>
            </Link>
          </Reveal>
        ))}
      </ul>
    </div>
  );
}
