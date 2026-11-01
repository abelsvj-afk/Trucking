"use client";

// Task 3.3 (TASKS.md), UI/UX upgrade. Drivers list: photo, name, role,
// phone, and the truck they're assigned to - a profile you can
// recognize and tap, not a bare name with a status word.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { EntityPhoto } from "@/components/EntityPhoto";
import { usePageTitle } from "@/lib/use-page-title";
import { driverRoleLabel } from "@/lib/fleet-display";
import type { Driver, Truck } from "@/types/entities";

export default function DriversListPage() {
  usePageTitle("Drivers");
  const { state, retry } = useApiList<Driver>("drivers");
  const trucks = useApiList<Truck>("trucks");
  const truckUnits = new Map(
    trucks.state.status === "loaded" ? trucks.state.result.data.map((t) => [t.id, t.unit_number]) : [],
  );

  return (
    <div>
      <PageHeader
        title="Drivers"
        purpose="Everyone who drives for you — contact, license, and the truck they're assigned to."
        action={
          <Link href="/fleet/drivers/new" className="page-action">
            Add driver
          </Link>
        }
      />

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <TeachingEmpty
          title="No drivers yet"
          message="Add yourself first — name, role, phone, CDL. Driver profiles tie loads, inspections, and duty logs to the person behind the wheel."
          action={<Link href="/fleet/drivers/new">Add your first driver</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((driver) => {
            const role = driverRoleLabel(driver.role);
            const truckUnit = driver.assigned_truck_id ? truckUnits.get(driver.assigned_truck_id) : null;
            const sub = [
              role,
              driver.phone,
              truckUnit ? `Truck ${truckUnit}` : driver.assigned_truck_id ? "Assigned truck" : "No truck assigned",
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={driver.id}>
                <Link href={`/fleet/drivers/${driver.id}`} className="row-with-photo">
                  <EntityPhoto
                    entityType="driver"
                    entityId={driver.id}
                    photoDocumentId={driver.photo_document_id}
                    size="thumb"
                    alt={`Photo of ${driver.name}`}
                  />
                  <span className="row-text">
                    <span className="row-title">
                      <strong data-status={driver.status === "active" ? "ok" : "paused"}>
                        {driver.status}
                      </strong>
                      {driver.name}
                    </span>
                    <span className="row-sub">{sub}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
