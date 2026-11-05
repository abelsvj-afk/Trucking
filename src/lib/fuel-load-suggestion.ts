// "Same truck, same day as Load ..." - a SUGGESTION the fuel form may offer (D-02):
// the owner taps to pick the load; nothing here assigns anything, and the form never
// pre-selects it. Pure.

import type { Load } from "@/types/entities";

const day = (iso: string) => iso.slice(0, 10);

export function suggestLoadsForFuel(
  loads: Pick<Load, "id" | "truck_id" | "pickup_date" | "delivery_date" | "status">[],
  truckId: string,
  purchasedAtIso: string,
): string[] {
  if (!truckId || !purchasedAtIso) return [];
  const d = day(purchasedAtIso);
  return loads
    .filter((l) => l.truck_id === truckId && l.status !== "cancelled" && l.pickup_date && l.pickup_date.slice(0, 10) <= d && (l.delivery_date ?? l.pickup_date).slice(0, 10) >= d)
    .map((l) => l.id);
}
