"use client";

// Task 3.14 (TASKS.md). Deliberately simple - a flat per-vehicle list,
// not an inventory system, per docs/schemas.md.

import Link from "next/link";
import { useState } from "react";
import { useApiList } from "@/lib/use-api-list";
import { usePickerList } from "@/lib/use-picker-list";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
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
      <h1>Equipment checklist</h1>
      <Link href="/fleet/equipment-checklist/new">Add item</Link>

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
          message="No checklist items yet — add your first one."
          action={<Link href="/fleet/equipment-checklist/new">Add item</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((item) => (
            <li key={item.id}>
              {vehicleLabel(item)} — {item.item_name}
              {item.quantity_on_hand != null && ` — qty ${item.quantity_on_hand}`}
              {item.last_checked_date && ` — checked ${item.last_checked_date}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
