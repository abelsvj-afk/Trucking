"use client";

// Bottom-tab navigation shell, per docs/design/ui-ux.md: Home / Loads /
// Fleet / Money / More. A route group (not part of the URL) so /login
// stays outside it - only authenticated screens get the nav.
//
// Task 3.12 (TASKS.md) accessibility pass additions: aria-current="page"
// on the active tab (WCAG 2.4.8, needs the current route via usePathname,
// hence "use client"), and a skip link (WCAG 2.4.1) so keyboard/screen-
// reader users can bypass the tab list straight to page content instead of
// tabbing through all five links on every single page.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HomeIcon, LoadsIcon, FleetIcon, MoneyIcon, MoreIcon } from "@/components/NavIcons";

const TABS = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/loads", label: "Loads", Icon: LoadsIcon },
  { href: "/fleet", label: "Fleet", Icon: FleetIcon },
  { href: "/money", label: "Money", Icon: MoneyIcon },
  { href: "/more", label: "More", Icon: MoreIcon },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div>
      <a href="#main-content">Skip to main content</a>
      <main id="main-content">{children}</main>
      <nav aria-label="Primary">
        <ul>
          {TABS.map(({ href, label, Icon }) => {
            const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <li key={href}>
                <Link href={href} aria-current={isActive ? "page" : undefined}>
                  <Icon />
                  <span>{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
