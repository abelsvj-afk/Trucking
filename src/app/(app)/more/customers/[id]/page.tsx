"use client";

// Reliability Unit A: the customer's own screen. Before this, a
// customer was a line in a list with no way to see it in full, fix
// its details, or delete it. Here: the customer's facts up top, an
// edit form mirroring the Add customer fields (PATCH on save), and
// the delete control at the bottom.

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { DeleteRecordButton } from "@/components/RecordLifecycle";
import { usePageTitle } from "@/lib/use-page-title";
import type { Customer } from "@/types/entities";

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Customer");
  const [customer, setCustomer] = useState<Customer | null>(null);
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

      <CustomerEditForm key={customer.id} customer={customer} onSaved={setCustomer} />

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

function CustomerEditForm({
  customer,
  onSaved,
}: {
  customer: Customer;
  onSaved: (customer: Customer) => void;
}) {
  const [name, setName] = useState(customer.name);
  const [email, setEmail] = useState(customer.contact_email ?? "");
  const [phone, setPhone] = useState(customer.contact_phone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ path: string; message: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<Customer>("customers", customer.id, {
        name,
        contact_email: email || null,
        contact_phone: phone || null,
      });
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
        setFieldErrors(err.fields ?? []);
      } else {
        setError("Couldn't save. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-label="Edit this customer">
      <h2>Edit this customer</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="edit-name">Name</label>
        <input id="edit-name" value={name} onChange={(event) => setName(event.target.value)} required />

        <label htmlFor="edit-email">Email</label>
        <input
          id="edit-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <label htmlFor="edit-phone">Phone</label>
        <input id="edit-phone" value={phone} onChange={(event) => setPhone(event.target.value)} />

        {error && <p role="alert">{error}</p>}
        {fieldErrors.length > 0 && (
          <ul role="alert">
            {fieldErrors.map((field) => (
              <li key={`${field.path}-${field.message}`}>
                {field.path}: {field.message}
              </li>
            ))}
          </ul>
        )}
        {saved && <p role="status">Saved.</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save changes"}
        </button>
      </form>
    </section>
  );
}
