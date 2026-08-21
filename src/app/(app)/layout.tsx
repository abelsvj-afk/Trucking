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

const TABS = [
  { href: "/", label: "Home" },
  { href: "/loads", label: "Loads" },
  { href: "/fleet", label: "Fleet" },
  { href: "/money", label: "Money" },
  { href: "/more", label: "More" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div>
      <a href="#main-content">Skip to main content</a>
      <main id="main-content">{children}</main>
      <nav aria-label="Primary">
        <ul>
          {TABS.map((tab) => {
            const isActive = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
            return (
              <li key={tab.href}>
                <Link href={tab.href} aria-current={isActive ? "page" : undefined}>
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
