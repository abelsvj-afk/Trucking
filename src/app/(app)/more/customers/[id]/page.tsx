"use client";

// Reliability Unit A: the customer's own screen. Before this, a
// customer was a line in a list with no way to see it in full, fix
// its details, or delete it. Here: the customer's facts up top, an
// edit form mirroring the Add customer fields (PATCH on save), and
// the delete control at the bottom.

import {use, useEffect, useState} from "react";
import Link from "next/link";
import {apiClient} from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import Sheet from "@/components/Sheet";
import CustomerEditForm from "@/components/edit/CustomerEditForm";
import {ListLoading, ListError} from "@/components/ListStates";
import {DeleteRecordButton} from "@/components/RecordLifecycle";
import {usePageTitle} from "@/lib/use-page-title";
import type {Customer} from "@/types/entities";

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Customer");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Customer>("customers", id)
      .then((row) => {
        if (!cancelled) setCustomer(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this customer. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Customer" purpose="One customer, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!customer) {
    return (
      <div>
        <PageHeader title="Customer" purpose="One customer, in full." />
        <ListLoading />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={customer.name}
        purpose="The shipper and how to reach them — its details, and the record controls, in one place."
      
        action={
          <button type="button" className="page-action" onClick={() => setEditOpen(true)}>
            Edit
          </button>
        }
      />

      <section aria-label="Customer facts">
        <h2>The customer</h2>
        <dl>
          <dt>Name</dt>
          <dd>{customer.name}</dd>
          <dt>Email</dt>
          <dd>{customer.contact_email ?? "—"}</dd>
          <dt>Phone</dt>
          <dd>{customer.contact_phone ?? "—"}</dd>
          <dt>Notes</dt>
          <dd>{customer.notes ?? "—"}</dd>
        </dl>
      </section>

      {editOpen && (
          <Sheet title="Edit customer" onClose={() => setEditOpen(false)}>
            <CustomerEditForm key={customer.id} customer={customer} onSaved={(updated) => { setCustomer(updated); setEditOpen(false); }} />
          </Sheet>
        )}

      <p>
        <Link href="/more/customers">Back to customers</Link>
      </p>

      <section aria-label="Delete this customer">
        <h2>Delete this customer</h2>
        <DeleteRecordButton
          resource="customers"
          id={customer.id}
          recordName={customer.name}
          listHref="/more/customers"
          listLabel="customers"
        />
      </section>
    </div>
  );
}
