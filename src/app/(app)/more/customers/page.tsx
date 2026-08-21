"use client";

// Task 3.4 (TASKS.md). Same pattern as fleet/trucks/page.tsx.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
import type { Customer } from "@/types/entities";

export default function CustomersListPage() {
  const { state, retry } = useApiList<Customer>("customers");

  return (
    <div>
      <h1>Customers</h1>
      <Link href="/more/customers/new">Add customer</Link>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <ListEmpty
          message="No customers yet — add your first one."
          action={<Link href="/more/customers/new">Add customer</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((customer) => (
            <li key={customer.id}>{customer.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
