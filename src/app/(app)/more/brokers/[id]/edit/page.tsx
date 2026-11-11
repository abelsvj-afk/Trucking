"use client";

// The standalone edit route for this broker (UI/UX Phase 4,
// spec §2.4): kept alive for deep links — Abel's links and any saved
// URL — while the detail page itself now edits in place in a Sheet.
// Both hosts render the SAME form component
// (src/components/edit/BrokerEditForm.tsx); on save this route returns to
// the detail page.

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import BrokerEditForm from "@/components/edit/BrokerEditForm";
import { apiClient } from "@/lib/api-client";
import { usePageTitle } from "@/lib/use-page-title";
import type { Broker } from "@/types/entities";

export default function BrokerEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Edit broker");
  const router = useRouter();
  const [entity, setEntity] = useState<Broker | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Broker>("brokers", id)
      .then((row) => {
        if (!cancelled) setEntity(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this record. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Edit broker" purpose="Change this broker's details." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!entity) {
    return (
      <div>
        <PageHeader title="Edit broker" purpose="Change this broker's details." />
        <ListLoading />
      </div>
    );
  }
  return (
    <div>
      <PageHeader title="Edit broker" purpose="Change this broker's details." />
      <BrokerEditForm
        broker={entity}
        onSaved={() => router.push(`/more/brokers/${id}`)}
      />
    </div>
  );
}
