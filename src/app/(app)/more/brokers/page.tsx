"use client";

// Task 3.5 (TASKS.md). Same pattern as fleet/trucks/page.tsx.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import type { Broker } from "@/types/entities";

export default function BrokersListPage() {
  usePageTitle("Brokers");
  const { state, retry } = useApiList<Broker>("brokers");

  return (
    <div>
      <h1>Brokers</h1>
      <Link href="/more/brokers/new">Add broker</Link>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <ListEmpty
          message="No brokers yet — add your first one."
          action={<Link href="/more/brokers/new">Add broker</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((broker) => (
            <li key={broker.id}>{broker.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
