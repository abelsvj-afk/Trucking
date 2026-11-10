"use client";

// TruckEditForm — extracted from the Truck detail page (UI/UX Phase 4,
// spec §2.4): ONE form component, two hosts — the detail page's
// Edit Sheet (in-place editing) and the standalone /edit route
// (kept alive for deep links, incl. Abel's). Saving calls the
// caller's onSaved with the updated record; each host decides
// what that means (close the sheet / return to the detail page).

import {useState, type FormEvent} from "react";
import {apiClient, ApiClientError} from "@/lib/api-client";
import {useToast} from "@/components/Toast";
import TruckProfileFields, {
  truckProfileFromTruck,
  truckProfileToPayload,
  type TruckProfileValues,
} from "@/components/TruckProfileFields";
import TruckIdentityFields, {
  truckIdentityFromTruck,
  truckIdentityToPayload,
  type TruckIdentityValues,
} from "@/components/TruckIdentityFields";
import type {Truck} from "@/types/entities";

export default function TruckEditForm({ truck, onSaved }: { truck: Truck; onSaved: (truck: Truck) => void }) {
  const toast = useToast();
  const [identity, setIdentity] = useState<TruckIdentityValues>(() => truckIdentityFromTruck(truck));
  const [profile, setProfile] = useState<TruckProfileValues>(() => truckProfileFromTruck(truck));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<Truck>("trucks", truck.id, {
        ...truckIdentityToPayload(identity),
        ...truckProfileToPayload(profile),
      });
      onSaved(updated);
      setSaved(true);
      toast.success("Saved");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <TruckIdentityFields values={identity} onChange={setIdentity} />
      <TruckProfileFields values={profile} onChange={setProfile} />

      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Saved.</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
