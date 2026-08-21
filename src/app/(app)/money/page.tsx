// Money tab index. Per docs/design/ui-ux.md, Money's own sections
// (Expenses/Fuel/Summary) are reached via links here - added as each
// lands (tasks 3.7-3.8, 3.11), not built ahead of what exists.
import Link from "next/link";

export default function MoneyPage() {
  return (
    <div>
      <h1>Money</h1>
      <ul>
        <li>
          <Link href="/money/expenses">Expenses</Link>
        </li>
        <li>
          <Link href="/money/fuel-purchases">Fuel purchases</Link>
        </li>
        <li>
          <Link href="/money/summary">Summary</Link>
        </li>
      </ul>
    </div>
  );
}
