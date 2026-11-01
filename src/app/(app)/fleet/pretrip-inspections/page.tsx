"use client";

// Task 3.15 (TASKS.md). A log of completed pre-trip walkarounds, most
// recent first - per docs/schemas.md, only the outcome is stored.
//
// UI/UX upgrade: purpose header, teaching empty state, outcome-led rows.

import Link from "next/link";
import { useState } from "react";
import { useApiList } from "@/lib/use-api-list";
import { usePickerList } from "@/lib/use-picker-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import type { PretripInspection, Truck, Trailer, Driver } from "@/types/entities";

export default function PretripInspectionsPage() {
  usePageTitle("Pre-trip inspections");
  const [truckId, setTruckId] = useState("");
  const { state, retry } = useApiList<PretripInspection>(
    "pretrip-inspections",
    truckId ? { truck_id: truckId } : undefined,
  );
  const trucks = usePickerList<Truck>("trucks");
  const trailers = usePickerList<Trailer>("trailers");
  const drivers = usePickerList<Driver>("drivers");

  function vehicleLabel(inspection: PretripInspection) {
    if (inspection.truck_id) {
      return trucks.find((t) => t.id === inspection.truck_id)?.unit_number ?? inspection.truck_id;
    }
    return trailers.find((t) => t.id === inspection.trailer_id)?.unit_number ?? inspection.trailer_id;
  }

  function driverLabel(inspection: PretripInspection) {
    if (!inspection.driver_id) return null;
    return drivers.find((d) => d.id === inspection.driver_id)?.name ?? null;
  }

  return (
    <div>
      <PageHeader
        title="Pre-trip inspections"
        purpose="The walk-around before you roll — logged, so a passed inspection (and every defect) is on record."
        action={
          <Link href="/fleet/pretrip-inspections/new" className="page-action">
            Log inspection
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
          title="No inspections logged yet"
          message="Before the first roll of the day, walk the truck and log it here — coupling, air lines, lights, tires. Thirty seconds now beats a roadside violation later."
          action={<Link href="/fleet/pretrip-inspections/new">Log your first inspection</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((inspection) => {
            const driver = driverLabel(inspection);
            return (
              <li key={inspection.id}>
                <span className="row-title">
                  <strong data-status={inspection.passed ? "ok" : "overdue"}>
                    {inspection.passed ? "Passed" : "Failed"}
                  </strong>
                  {new Date(inspection.inspected_at).toLocaleDateString()} — Truck/Trailer{" "}
                  {vehicleLabel(inspection)}
                </span>
                {(driver || inspection.defects_found) && (
                  <span className="row-sub">
                    {[driver, inspection.defects_found].filter(Boolean).join(" · ")}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
