"use client";

// Optional "which load was this fuel for?" picker (Unit D, ruling D-02). Assignment is
// the owner's act: the suggestion below only offers a tap, it never selects. Leaving it
// empty is a normal state - the fuel counts as "Fuel not assigned to a load".

import { usePickerList } from "@/lib/use-picker-list";
import { suggestLoadsForFuel } from "@/lib/fuel-load-suggestion";
import type { Load } from "@/types/entities";

const label = (l: Load) => `${l.origin} → ${l.destination}${l.pickup_date ? ` (${l.pickup_date.slice(0, 10)})` : ""}`;

export default function FuelLoadPicker({
  id,
  value,
  onChange,
  truckId,
  purchasedAt,
}: {
  id: string;
  value: string;
  onChange: (loadId: string) => void;
  truckId: string;
  purchasedAt: string;
}) {
  const loads = usePickerList<Load>("loads");
  const suggested = value ? [] : suggestLoadsForFuel(loads, truckId, purchasedAt);
  return (
    <>
      <label htmlFor={id}>Load this fuel was for (optional)</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Not assigned to a load</option>
        {loads.map((l) => (
          <option key={l.id} value={l.id}>
            {label(l)}
          </option>
        ))}
      </select>
      <p className="row-sub">Assign it only if this fuel was for that load. Unassigned fuel is still counted in your period costs.</p>
      {suggested.map((loadId) => {
        const l = loads.find((x) => x.id === loadId);
        return l ? (
          <p key={loadId} className="row-sub">
            Same truck, same day as {label(l)}.{" "}
            <button type="button" onClick={() => onChange(loadId)}>
              Assign it?
            </button>
          </p>
        ) : null;
      })}
    </>
  );
}
