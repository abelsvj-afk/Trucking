"use client";

// The standalone edit route for this load (UI/UX Phase 4,
// spec §2.4): kept alive for deep links — Abel's links and any saved
// URL — while the detail page itself now edits in place in a Sheet.
// Both hosts render the SAME form component
// (src/components/edit/LoadEditForm.tsx); on save this route returns to
// the detail page.

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import LoadEditForm from "@/components/edit/LoadEditForm";
import { apiClient } from "@/lib/api-client";
import { usePageTitle } from "@/lib/use-page-title";
import type { Load } from "@/types/entities";

export default function LoadEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Edit load");
  const router = useRouter();
  const [entity, setEntity] = useState<Load | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Load>("loads", id)
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
        <PageHeader title="Edit load" purpose="Change this load's details." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!entity) {
    return (
      <div>
        <PageHeader title="Edit load" purpose="Change this load's details." />
        <ListLoading />
      </div>
    );
  }
  return (
    <div>
      <PageHeader title="Edit load" purpose="Change this load's details." />
      <LoadEditForm
        load={entity}
        onSaved={() => router.push(`/loads/${id}`)}
      />
    </div>
  );
}
