"use client";

// Task 3.9 (TASKS.md). Filterable by truck (via the same filterableFields
// mechanism loads uses for ?status=) so this list can act as a given
// truck's maintenance history, per the task's acceptance criteria.

import Link from "next/link";
import { useState } from "react";
import { useApiList } from "@/lib/use-api-list";
import { usePickerList } from "@/lib/use-picker-list";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import type { MaintenanceEvent, Truck } from "@/types/entities";

export default function MaintenanceEventsListPage() {
  usePageTitle("Maintenance");
  const [truckId, setTruckId] = useState("");
  const { state, retry } = useApiList<MaintenanceEvent>(
    "maintenance-events",
    truckId ? { truck_id: truckId } : undefined,
  );
  const trucks = usePickerList<Truck>("trucks");
  const truckLabel = (id: string) => trucks.find((truck) => truck.id === id)?.unit_number ?? id;

  return (
    <div>
      <h1>Maintenance</h1>
      <Link href="/fleet/maintenance-events/new">Add maintenance event</Link>

      <label htmlFor="truck_filter">Truck</label>
      <select id="truck_filter" value={truckId} onChange={(event) => setTruckId(event.target.value)}>
        <option value="">All trucks</option>
        {trucks.map((truck) => (
          <option key={truck.id} value={truck.id}>
            {truck.unit_number}
          </option>
        ))}
      </select>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <ListEmpty
          message="No maintenance events yet — add your first one."
          action={<Link href="/fleet/maintenance-events/new">Add maintenance event</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((event) => (
            <li key={event.id}>
              {event.service_date} — {truckLabel(event.truck_id)} — {event.description}
              {event.cost_cents != null && ` — $${(event.cost_cents / 100).toFixed(2)}`}
              {event.mileage_at_service != null && ` — ${event.mileage_at_service} mi`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
