"use client";

// Task 3.4 (TASKS.md), UI/UX upgrade: rows show contact details, not
// just a bare name.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import {
  useDeletedToggle,
  DeletedToggleButton,
  DeletedListSection,
} from "@/components/RecordLifecycle";
import type { Customer } from "@/types/entities";

export default function CustomersListPage() {
  usePageTitle("Customers");
  const [showDeleted, setShowDeleted] = useDeletedToggle();
  const { state, retry } = useApiList<Customer>("customers");

  return (
    <div>
      <PageHeader
        title="Customers"
        purpose="The shippers you haul for — contacts kept with the business, not in a phone you might lose."
        action={
          <Link href="/more/customers/new" className="page-action">
            Add customer
          </Link>
        }
      />

      <DeletedToggleButton showDeleted={showDeleted} onChange={setShowDeleted} listLabel="customers" />

      {showDeleted ? (
        <DeletedListSection
          resource="customers"
          labelFor={(customer: Customer) => customer.name}
          sublabelFor={(customer: Customer) =>
            [customer.contact_phone, customer.contact_email].filter(Boolean).join(" · ") || null
          }
        />
      ) : (
        <>
      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <TeachingEmpty
          title="No customers yet"
          message="Add the shippers you haul for directly. A customer on record is one the assistant can attach loads to and you can call without digging through old rate cons."
          action={<Link href="/more/customers/new">Add your first customer</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((customer) => {
            const sub = [customer.contact_phone, customer.contact_email].filter(Boolean).join(" · ");
            return (
              <li key={customer.id}>
                <Link href={`/more/customers/${customer.id}`}>
                  <span className="row-title">{customer.name}</span>
                  {sub && <span className="row-sub">{sub}</span>}
                  {customer.notes && <span className="row-sub">{customer.notes}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
        </>
      )}
    </div>
  );
}
