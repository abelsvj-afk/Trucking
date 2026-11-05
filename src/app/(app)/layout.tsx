"use client";

// Bottom-tab navigation shell, per docs/design/ui-ux.md. A route group
// (not part of the URL) so /login stays outside it — only authenticated
// screens get the nav. The tab set itself lives in src/lib/nav-config.ts
// (BOTTOM_TABS — the single switch; see that file for the PARKED owner
// decision (a) it implements and how to revert it). Icons are Lucide
// (22px, strokeWidth 1.75), purely decorative (aria-hidden — the tab's
// own link text is what screen readers announce).
//
// Task 3.12 (TASKS.md) accessibility pass additions: aria-current="page"
// on the active tab (WCAG 2.4.8, needs the current route via
// usePathname, hence "use client"), and a skip link (WCAG 2.4.1) so
// keyboard/screen-reader users can bypass the tab list straight to
// page content instead of tabbing through every link on every page.
// Active state comes from nav-config's longest-prefix resolver, so
// /more/assistant lights Assistant (not More) and /smart-path/drive
// lights Smart Path.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BOTTOM_TABS, resolveActiveTab } from "@/lib/nav-config";
import PageTransition from "@/components/PageTransition";
import AbelDrop from "@/components/AbelDrop";
import LiveDataProvider from "@/components/live/LiveDataProvider";
import MotionLock from "@/components/MotionLock";
import LocationPrompt from "@/components/LocationPrompt";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const activeTab = resolveActiveTab(pathname);

  return (
    <LiveDataProvider>
      <div>
        <a href="#main-content">Skip to main content</a>
        <MotionLock />
      <main id="main-content">
          <PageTransition>{children}</PageTransition>
        </main>
        <nav aria-label="Primary">
          <ul>
            {BOTTOM_TABS.map((tab) => {
              const isActive = activeTab?.href === tab.href;
              const Icon = tab.Icon;
              return (
                <li key={tab.href}>
                  <Link
                    href={tab.href}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
                    <span>{tab.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <AbelDrop />
        <LocationPrompt />
      </div>
    </LiveDataProvider>
  );
}
