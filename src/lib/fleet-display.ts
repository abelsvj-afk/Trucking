// UI/UX upgrade: the display labels for the fleet profile fields added
// by migration 00027, kept in one place so the picklists (Add/Edit
// forms), the list rows, and the detail screens can never drift into
// calling the same truck type three different things.

import type { DriverRole } from "@/types/entities";

// The truck-type picklist. Values are what's stored for the known
// kinds; "other" in the form swaps in a free-text field and stores the
// owner's own words instead (truck_type is a text column, same
// precedent as trailers.trailer_type).
export const TRUCK_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "sleeper_semi", label: "Sleeper semi" },
  { value: "day_cab_semi", label: "Day cab semi" },
  { value: "box_truck", label: "Box truck" },
  { value: "straight_truck", label: "Straight truck" },
  { value: "hotshot", label: "Hotshot / gooseneck" },
];

export const TRUCK_TYPE_OTHER = "other";

export function truckTypeLabel(truckType: string | null | undefined): string | null {
  if (!truckType) return null;
  const known = TRUCK_TYPE_OPTIONS.find((option) => option.value === truckType);
  return known ? known.label : truckType;
}

export const DRIVER_ROLE_OPTIONS: { value: DriverRole; label: string }[] = [
  { value: "owner_operator", label: "Owner-operator" },
  { value: "company_driver", label: "Company driver" },
  { value: "contract_driver", label: "Contract driver" },
  { value: "other", label: "Other" },
];

export function driverRoleLabel(role: DriverRole | null | undefined): string | null {
  if (!role) return null;
  const known = DRIVER_ROLE_OPTIONS.find((option) => option.value === role);
  return known ? known.label : role;
}

// "12,400 mi" / "—" - one formatting for mileage everywhere it shows.
export function formatMileage(miles: number | null | undefined): string | null {
  if (miles == null) return null;
  return `${miles.toLocaleString("en-US")} mi`;
}
