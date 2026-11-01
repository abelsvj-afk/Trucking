"use client";

// Task 3.5 (TASKS.md), UI/UX upgrade: rows show the broker's MC number
// and contact - the things you actually look a broker up for - not
// just a name.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import type { Broker } from "@/types/entities";

export default function BrokersListPage() {
  usePageTitle("Brokers");
  const { state, retry } = useApiList<Broker>("brokers");

  return (
    <div>
      <PageHeader
        title="Brokers"
        purpose="The brokers you book through — MC numbers and contacts, kept where you can check them before you sign."
        action={
          <Link href="/more/brokers/new" className="page-action">
            Add broker
          </Link>
        }
      />

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <TeachingEmpty
          title="No brokers yet"
          message="Add the brokers you work with — name and MC number at minimum. Having the MC on record is how you verify a broker before a load, not after a problem."
          action={<Link href="/more/brokers/new">Add your first broker</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((broker) => {
            const sub = [
              broker.mc_number ? `MC ${broker.mc_number}` : null,
              broker.contact_phone ?? broker.contact_email ?? null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={broker.id}>
                <span className="row-title">{broker.name}</span>
                {sub && <span className="row-sub">{sub}</span>}
                {broker.notes && <span className="row-sub">{broker.notes}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
