// More tab index, per docs/design/ui-ux.md. Customers/Brokers land here
// now (tasks 3.4-3.5); Documents and Account/Settings (incl. future AI
// kill switches, per docs/governance.md) land as their own tasks.
import Link from "next/link";

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
      </ul>
    </div>
  );
}
