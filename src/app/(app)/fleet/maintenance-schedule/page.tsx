"use client";

// Task 3.13 (TASKS.md), per docs/design/ui-ux.md: due status computed
// client-side (src/lib/maintenance-schedule.ts) against the linked
// truck's current_mileage, badged the same way Loads' Draft status is -
// a labeled badge, never color alone.
//
// UI/UX upgrade: purpose header, teaching empty state, and the
// interval/last-done facts on each row so "due soon" says why.

import Link from "next/link";
import { useState } from "react";
import { useApiList } from "@/lib/use-api-list";
import { usePickerList } from "@/lib/use-picker-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
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

  function intervalLine(schedule: MaintenanceSchedule) {
    const parts: string[] = [];
    if (schedule.interval_miles != null) parts.push(`every ${schedule.interval_miles.toLocaleString("en-US")} mi`);
    if (schedule.interval_days != null) parts.push(`every ${schedule.interval_days} days`);
    if (schedule.last_done_date) {
      parts.push(`last done ${new Date(`${schedule.last_done_date}T12:00:00`).toLocaleDateString()}`);
    }
    return parts.join(" · ");
  }

  return (
    <div>
      <PageHeader
        title="Maintenance schedule"
        purpose="Recurring work — oil, inspections, tires — tracked against miles and days so it warns you before it's overdue."
        action={
          <Link href="/fleet/maintenance-schedule/new" className="page-action">
            Add item
          </Link>
        }
      />

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
        <TeachingEmpty
          title="No recurring items yet"
          message="Add the work that repeats — oil every 15,000 miles, inspection every year — and this screen watches the odometer and the calendar for you."
          action={<Link href="/fleet/maintenance-schedule/new">Add your first item</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((schedule) => {
            const status = dueBadge(schedule);
            return (
              <li key={schedule.id}>
                <span className="row-title">
                  <strong data-status={status}>{STATUS_LABELS[status]}</strong>
                  {schedule.description}
                </span>
                <span className="row-sub">
                  {vehicleLabel(schedule)}
                  {intervalLine(schedule) ? ` · ${intervalLine(schedule)}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
