"use client";

// Reliability Unit A: the broker's own screen. Before this, a broker
// was a line in a list with no way to see it in full, fix its
// details, or delete it. Here: the broker's facts up top, an edit
// form mirroring the Add broker fields (PATCH on save), and the
// delete control at the bottom.

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { DeleteRecordButton } from "@/components/RecordLifecycle";
import { usePageTitle } from "@/lib/use-page-title";
import type { Broker } from "@/types/entities";

export default function BrokerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Broker");
  const [broker, setBroker] = useState<Broker | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Broker>("brokers", id)
      .then((row) => {
        if (!cancelled) setBroker(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this broker. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Broker" purpose="One broker, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!broker) {
    return (
      <div>
        <PageHeader title="Broker" purpose="One broker, in full." />
        <ListLoading />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={broker.name}
        purpose="The broker's MC number and contacts — its details, and the record controls, in one place."
      />

      <section aria-label="Broker facts">
        <h2>The broker</h2>
        <dl>
          <dt>Name</dt>
          <dd>{broker.name}</dd>
          <dt>MC number</dt>
          <dd>{broker.mc_number ?? "—"}</dd>
          <dt>Email</dt>
          <dd>{broker.contact_email ?? "—"}</dd>
          <dt>Phone</dt>
          <dd>{broker.contact_phone ?? "—"}</dd>
          <dt>Notes</dt>
          <dd>{broker.notes ?? "—"}</dd>
        </dl>
      </section>

      <BrokerEditForm key={broker.id} broker={broker} onSaved={setBroker} />

      <p>
        <Link href="/more/brokers">Back to brokers</Link>
      </p>

      <section aria-label="Delete this broker">
        <h2>Delete this broker</h2>
        <DeleteRecordButton
          resource="brokers"
          id={broker.id}
          recordName={broker.name}
          listHref="/more/brokers"
          listLabel="brokers"
        />
      </section>
    </div>
  );
}

function BrokerEditForm({ broker, onSaved }: { broker: Broker; onSaved: (broker: Broker) => void }) {
  const [name, setName] = useState(broker.name);
  const [mcNumber, setMcNumber] = useState(broker.mc_number ?? "");
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
      const updated = await apiClient.update<Broker>("brokers", broker.id, {
        name,
        mc_number: mcNumber || null,
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
    <section aria-label="Edit this broker">
      <h2>Edit this broker</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="edit-name">Name</label>
        <input id="edit-name" value={name} onChange={(event) => setName(event.target.value)} required />

        <label htmlFor="edit-mc_number">MC number</label>
        <input
          id="edit-mc_number"
          value={mcNumber}
          onChange={(event) => setMcNumber(event.target.value)}
        />

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
