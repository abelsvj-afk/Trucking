"use client";

// Task 3.1 (TASKS.md), UI/UX upgrade. Trucks list: each row is the
// truck itself - photo, unit, type, make/model/year, status, mileage -
// linking to the truck's own screen, instead of a bare
// "unit — status" string nobody can tell trucks apart with.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { EntityPhoto } from "@/components/EntityPhoto";
import { usePageTitle } from "@/lib/use-page-title";
import { truckTypeLabel, formatMileage } from "@/lib/fleet-display";
import type { Truck } from "@/types/entities";

const STATUS_BADGES: Record<Truck["status"], string> = {
  active: "ok",
  maintenance: "unknown",
  inactive: "paused",
};

export default function TrucksListPage() {
  usePageTitle("Trucks");
  const { state, retry } = useApiList<Truck>("trucks");

  return (
    <div>
      <PageHeader
        title="Trucks"
        purpose="Every truck you run, what kind it is, and where it stands."
        action={
          <Link href="/fleet/trucks/new" className="page-action">
            Add truck
          </Link>
        }
      />

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <TeachingEmpty
          title="No trucks yet"
          message="Add the truck you're driving. Its type, size, and photo go here — Smart Path plans from them, and maintenance history hangs off the truck itself."
          action={<Link href="/fleet/trucks/new">Add your first truck</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((truck) => {
            const type = truckTypeLabel(truck.truck_type);
            const identity = [truck.year, truck.make, truck.model].filter(Boolean).join(" ");
            const mileage = formatMileage(truck.current_mileage);
            return (
              <li key={truck.id}>
                <Link href={`/fleet/trucks/${truck.id}`} className="row-with-photo">
                  <EntityPhoto
                    entityType="truck"
                    entityId={truck.id}
                    photoDocumentId={truck.photo_document_id}
                    size="thumb"
                    alt={`Photo of truck ${truck.unit_number}`}
                  />
                  <span className="row-text">
                    <span className="row-title">
                      <strong data-status={STATUS_BADGES[truck.status]}>{truck.status}</strong>
                      Truck {truck.unit_number}
                      {type ? ` — ${type}` : ""}
                    </span>
                    <span className="row-sub">
                      {[identity, mileage].filter(Boolean).join(" · ") || "Tap to complete this truck's profile"}
                    </span>
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
