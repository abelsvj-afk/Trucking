"use client";

// Task 3.14 (TASKS.md). Deliberately simple - a flat per-vehicle list,
// not an inventory system, per docs/schemas.md.
//
// UI/UX upgrade: purpose header, teaching empty state, item-led rows.

import Link from "next/link";
import { useState } from "react";
import { useApiList } from "@/lib/use-api-list";
import { usePickerList } from "@/lib/use-picker-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import type { EquipmentChecklistItem, Truck, Trailer } from "@/types/entities";

export default function EquipmentChecklistPage() {
  usePageTitle("Equipment checklist");
  const [truckId, setTruckId] = useState("");
  const { state, retry } = useApiList<EquipmentChecklistItem>(
    "equipment-checklist-items",
    truckId ? { truck_id: truckId } : undefined,
  );
  const trucks = usePickerList<Truck>("trucks");
  const trailers = usePickerList<Trailer>("trailers");

  function vehicleLabel(item: EquipmentChecklistItem) {
    if (item.truck_id) return trucks.find((t) => t.id === item.truck_id)?.unit_number ?? item.truck_id;
    return trailers.find((t) => t.id === item.trailer_id)?.unit_number ?? item.trailer_id;
  }

  return (
    <div>
      <PageHeader
        title="Equipment checklist"
        purpose="The gear that should be on board — straps, fuses, bulbs, tools — so a missing item is found here, not on the shoulder."
        action={
          <Link href="/fleet/equipment-checklist/new" className="page-action">
            Add item
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
          title="No checklist items yet"
          message="List what must be on the truck — spare fuses, bulbs, zip ties, the tools you'd hate to lack at 2 a.m. — then check it off as you verify it's aboard."
          action={<Link href="/fleet/equipment-checklist/new">Add your first item</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((item) => (
            <li key={item.id}>
              <span className="row-title">{item.item_name}</span>
              <span className="row-sub">
                {vehicleLabel(item)}
                {item.quantity_on_hand != null && ` · qty ${item.quantity_on_hand}`}
                {item.last_checked_date &&
                  ` · checked ${new Date(`${item.last_checked_date}T12:00:00`).toLocaleDateString()}`}
                {item.notes ? ` · ${item.notes}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
