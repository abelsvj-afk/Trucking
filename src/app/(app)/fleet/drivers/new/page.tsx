"use client";

// Task 3.3 (TASKS.md). Same pattern as fleet/trucks/new/page.tsx, plus a
// truck-assignment dropdown - a raw truck-ID text field would be
// unusable, per CLAUDE.md's "must be genuinely usable" rule.

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import type { Driver, Truck } from "@/types/entities";

export default function NewDriverPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [assignedTruckId, setAssignedTruckId] = useState("");
  const [trucks, setTrucks] = useState<Truck[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiClient
      .list<Truck>("trucks", { limit: "200" })
      .then((result) => setTrucks(result.data))
      .catch(() => setTrucks([]));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await apiClient.create<Driver>("drivers", {
        name,
        assigned_truck_id: assignedTruckId || null,
      });
      router.push("/fleet/drivers");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Add driver</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="name">Name</label>
        <input id="name" value={name} onChange={(event) => setName(event.target.value)} required />

        <label htmlFor="assigned_truck_id">Assigned truck</label>
        <select
          id="assigned_truck_id"
          value={assignedTruckId}
          onChange={(event) => setAssignedTruckId(event.target.value)}
        >
          <option value="">Unassigned</option>
          {trucks.map((truck) => (
            <option key={truck.id} value={truck.id}>
              {truck.unit_number}
            </option>
          ))}
        </select>

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
