"use client";

// Reliability Unit A: the broker's own screen. Before this, a broker
// was a line in a list with no way to see it in full, fix its
// details, or delete it. Here: the broker's facts up top, an edit
// form mirroring the Add broker fields (PATCH on save), and the
// delete control at the bottom.

import {use, useEffect, useState} from "react";
import Link from "next/link";
import {apiClient} from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import Sheet from "@/components/Sheet";
import BrokerEditForm from "@/components/edit/BrokerEditForm";
import {ListLoading, ListError} from "@/components/ListStates";
import {DeleteRecordButton} from "@/components/RecordLifecycle";
import {usePageTitle} from "@/lib/use-page-title";
import type {Broker} from "@/types/entities";

export default function BrokerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Broker");
  const [broker, setBroker] = useState<Broker | null>(null);
  const [editOpen, setEditOpen] = useState(false);
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
      
        action={
          <button type="button" className="page-action" onClick={() => setEditOpen(true)}>
            Edit
          </button>
        }
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

      {editOpen && (
          <Sheet title="Edit broker" onClose={() => setEditOpen(false)}>
            <BrokerEditForm key={broker.id} broker={broker} onSaved={(updated) => { setBroker(updated); setEditOpen(false); }} />
          </Sheet>
        )}

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
