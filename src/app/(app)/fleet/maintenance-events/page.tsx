"use client";

// Task 3.9 (TASKS.md). Filterable by truck (via the same filterableFields
// mechanism loads uses for ?status=) so this list can act as a given
// truck's maintenance history, per the task's acceptance criteria.
//
// UI/UX upgrade: purpose header, teaching empty state, rows led by
// the work done with the truck/date/cost as the summary line.

import Link from "next/link";
import { useState } from "react";
import { useApiList } from "@/lib/use-api-list";
import { usePickerList } from "@/lib/use-picker-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
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
      <PageHeader
        title="Maintenance"
        purpose="Every repair and service, logged with its cost — the truck's history, not your memory of it."
        action={
          <Link href="/fleet/maintenance-events/new" className="page-action">
            Add event
          </Link>
        }
      />

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
        <TeachingEmpty
          title="No maintenance events yet"
          message="When work gets done — oil, tires, a repair on the road — log it here with the cost. This history drives the maintenance schedule and your true cost per mile."
          action={<Link href="/fleet/maintenance-events/new">Add your first event</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((event) => (
            <li key={event.id}>
              <span className="row-title">{event.description}</span>
              <span className="row-sub">
                Truck {truckLabel(event.truck_id)} ·{" "}
                {new Date(`${event.service_date}T12:00:00`).toLocaleDateString()}
                {event.cost_cents != null && ` · $${(event.cost_cents / 100).toFixed(2)}`}
                {event.mileage_at_service != null &&
                  ` · at ${event.mileage_at_service.toLocaleString("en-US")} mi`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
