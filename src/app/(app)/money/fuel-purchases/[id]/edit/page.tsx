"use client";

// The standalone edit route for this fuelpurchase (UI/UX Phase 4,
// spec §2.4): kept alive for deep links — Abel's links and any saved
// URL — while the detail page itself now edits in place in a Sheet.
// Both hosts render the SAME form component
// (src/components/edit/FuelPurchaseEditForm.tsx); on save this route returns to
// the detail page.

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import FuelPurchaseEditForm from "@/components/edit/FuelPurchaseEditForm";
import { apiClient } from "@/lib/api-client";
import { usePageTitle } from "@/lib/use-page-title";
import type { FuelPurchase } from "@/types/entities";

export default function FuelPurchaseEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Edit fuel purchase");
  const router = useRouter();
  const [entity, setEntity] = useState<FuelPurchase | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<FuelPurchase>("fuel-purchases", id)
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
        <PageHeader title="Edit fuel purchase" purpose="Change this fuel purchase's details." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!entity) {
    return (
      <div>
        <PageHeader title="Edit fuel purchase" purpose="Change this fuel purchase's details." />
        <ListLoading />
      </div>
    );
  }
  return (
    <div>
      <PageHeader title="Edit fuel purchase" purpose="Change this fuel purchase's details." />
      <FuelPurchaseEditForm
        purchase={entity}
        onSaved={() => router.push(`/money/fuel-purchases/${id}`)}
      />
    </div>
  );
}
