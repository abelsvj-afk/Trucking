// More tab index, per docs/design/ui-ux.md. Customers/Brokers land here
// now (tasks 3.4-3.5); Documents and Account/Settings (incl. future AI
// kill switches, per docs/governance.md) land as their own tasks.
//
// A Server Component (no "use client"), so it uses Next's own `metadata`
// export for a distinct <title> (WCAG 2.4.2) rather than the
// usePageTitle() client hook every data-fetching screen uses instead.
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "More — Trucking OS" };

export default function MorePage() {
  return (
    <div>
      <h1>More</h1>
      <ul>
        <li>
          <Link href="/more/customers">Customers</Link>
        </li>
        <li>
          <Link href="/more/brokers">Brokers</Link>
        </li>
        <li>
          <Link href="/more/documents">Documents</Link>
        </li>
        <li>
          <Link href="/more/industry-intelligence">Industry intelligence</Link>
        </li>
        <li>
          <Link href="/more/settings">Account &amp; settings</Link>
        </li>
      </ul>
    </div>
  );
}
