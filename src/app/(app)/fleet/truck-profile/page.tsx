"use client";

// Smart Path v1 (docs/design/driver-mvp.md §8.2). The truck-profile
// editor: pick a truck, capture its size/speed/appliance inventory.
// This is the page the owner uses on the first run to record Steven's
// truck - the food route and the plan's speed math read exactly
// these fields. Saves through the standard PATCH /api/v1/trucks/[id].
//
// Selection is derived (override ?? first truck), and the form is a
// child component keyed by truck id, so it mounts with that truck's
// values as its initial state - no effect-syncing, per the repo's
// react-hooks/set-state-in-effect rule.

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import TruckProfileFields, {
  truckProfileFromTruck,
  truckProfileToPayload,
  type TruckProfileValues,
} from "@/components/TruckProfileFields";
import PageHeader from "@/components/PageHeader";
import type { Truck } from "@/types/entities";

export default function TruckProfilePage() {
  usePageTitle("Truck profile");
  const { state, retry } = useApiList<Truck>("trucks");
  const [truckIdOverride, setTruckIdOverride] = useState<string | null>(null);

  const trucks = useMemo(
    () => (state.status === "loaded" ? state.result.data : []),
    [state],
  );
  const truckId = truckIdOverride ?? trucks[0]?.id ?? "";
  const selected = trucks.find((truck) => truck.id === truckId) ?? null;

  return (
    <div>
      <PageHeader
        title="Truck profile"
        purpose="Size, governed speed, and what's in the cab — Smart Path plans routes, fuel stops, and food from this. Measure the real truck; a wrong height here is worse than none."
      />

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && trucks.length === 0 && (
        <TeachingEmpty
          title="No trucks yet"
          message="The truck profile describes a truck — so add the truck first, then come back here to capture its size, speed, and cab setup for Smart Path."
          action={<Link href="/fleet/trucks/new">Add a truck</Link>}
        />
      )}

      {trucks.length > 0 && selected && (
        <div>
          <label htmlFor="truck_id">Truck</label>
          <select
            id="truck_id"
            value={truckId}
            onChange={(event) => setTruckIdOverride(event.target.value)}
          >
            {trucks.map((truck) => (
              <option key={truck.id} value={truck.id}>
                {truck.unit_number} — {truck.status}
              </option>
            ))}
          </select>

          <TruckProfileForm key={selected.id} truck={selected} onSaved={retry} />
        </div>
      )}
    </div>
  );
}

function TruckProfileForm({ truck, onSaved }: { truck: Truck; onSaved: () => void }) {
  const [values, setValues] = useState<TruckProfileValues>(() => truckProfileFromTruck(truck));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      await apiClient.update<Truck>("trucks", truck.id, truckProfileToPayload(values));
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <TruckProfileFields values={values} onChange={setValues} />

      {error && <p role="alert">{error}</p>}
      {saved && <p>Profile saved.</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}
