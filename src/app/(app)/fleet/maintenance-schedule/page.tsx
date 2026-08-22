"use client";

// Task 3.13 (TASKS.md), per docs/design/ui-ux.md: due status computed
// client-side (src/lib/maintenance-schedule.ts) against the linked
// truck's current_mileage, badged the same way Loads' Draft status is -
// a labeled badge, never color alone.

import Link from "next/link";
import { useState } from "react";
import { useApiList } from "@/lib/use-api-list";
import { usePickerList } from "@/lib/use-picker-list";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import { computeDueStatus, type DueStatus } from "@/lib/maintenance-schedule";
import type { MaintenanceSchedule, Truck, Trailer } from "@/types/entities";

const STATUS_LABELS: Record<DueStatus, string> = {
  ok: "On track",
  "due-soon": "Due soon",
  overdue: "Overdue",
  paused: "Paused",
  unknown: "Unknown",
};

export default function MaintenanceSchedulePage() {
  usePageTitle("Maintenance schedule");
  const [vehicleFilter, setVehicleFilter] = useState("");
  const { state, retry } = useApiList<MaintenanceSchedule>(
    "maintenance-schedules",
    vehicleFilter ? { truck_id: vehicleFilter } : undefined,
  );
  const trucks = usePickerList<Truck>("trucks");
  const trailers = usePickerList<Trailer>("trailers");

  function vehicleLabel(schedule: MaintenanceSchedule) {
    if (schedule.truck_id) {
      return trucks.find((t) => t.id === schedule.truck_id)?.unit_number ?? schedule.truck_id;
    }
    return trailers.find((t) => t.id === schedule.trailer_id)?.unit_number ?? schedule.trailer_id;
  }

  function dueBadge(schedule: MaintenanceSchedule) {
    const truck = schedule.truck_id ? trucks.find((t) => t.id === schedule.truck_id) : undefined;
    const { status } = computeDueStatus(schedule, truck?.current_mileage ?? null);
    return status;
  }

  return (
    <div>
      <h1>Maintenance schedule</h1>
      <Link href="/fleet/maintenance-schedule/new">Add schedule item</Link>

      <label htmlFor="truck_filter">Truck</label>
      <select
        id="truck_filter"
        value={vehicleFilter}
        onChange={(event) => setVehicleFilter(event.target.value)}
      >
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
          message="No recurring maintenance items yet — add your first one."
          action={<Link href="/fleet/maintenance-schedule/new">Add schedule item</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((schedule) => {
            const status = dueBadge(schedule);
            return (
              <li key={schedule.id}>
                <strong data-status={status}>{STATUS_LABELS[status]}</strong>
                {vehicleLabel(schedule)} — {schedule.description}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
