// Bottom-tab navigation shell, per docs/design/ui-ux.md: Home / Loads /
// Fleet / Money / More. A route group (not part of the URL) so /login
// stays outside it - only authenticated screens get the nav.

import Link from "next/link";

const TABS = [
  { href: "/", label: "Home" },
  { href: "/loads", label: "Loads" },
  { href: "/fleet", label: "Fleet" },
  { href: "/money", label: "Money" },
  { href: "/more", label: "More" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <main>{children}</main>
      <nav aria-label="Primary">
        <ul>
          {TABS.map((tab) => (
            <li key={tab.href}>
              <Link href={tab.href}>{tab.label}</Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
