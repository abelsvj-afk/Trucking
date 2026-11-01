"use client";

// UI/UX upgrade: the truck identity field set - unit number, TYPE
// (the picklist the owner asked for: sleeper, day cab, box, straight,
// hotshot, or his own words), make/model/year, VIN, status, mileage.
// Shared by Add Truck and the truck detail editor, the same
// no-drift reasoning as TruckProfileFields. Before this upgrade the
// Add Truck form asked only for a unit number - the schema's
// make/model/year/status fields existed with no way to fill them in.

import { TRUCK_TYPE_OPTIONS, TRUCK_TYPE_OTHER } from "@/lib/fleet-display";
import type { Truck } from "@/types/entities";

export interface TruckIdentityValues {
  unitNumber: string;
  /** A TRUCK_TYPE_OPTIONS slug, TRUCK_TYPE_OTHER, or "" (not set). */
  typeChoice: string;
  /** The owner's own words, used when typeChoice is "other". */
  typeCustom: string;
  make: string;
  model: string;
  year: string;
  vin: string;
  status: string;
  currentMileage: string;
}

export const EMPTY_TRUCK_IDENTITY: TruckIdentityValues = {
  unitNumber: "",
  typeChoice: "",
  typeCustom: "",
  make: "",
  model: "",
  year: "",
  vin: "",
  status: "active",
  currentMileage: "",
};

export function truckIdentityFromTruck(truck: Truck): TruckIdentityValues {
  const known = TRUCK_TYPE_OPTIONS.some((option) => option.value === truck.truck_type);
  return {
    unitNumber: truck.unit_number,
    typeChoice: truck.truck_type ? (known ? truck.truck_type : TRUCK_TYPE_OTHER) : "",
    typeCustom: truck.truck_type && !known ? truck.truck_type : "",
    make: truck.make ?? "",
    model: truck.model ?? "",
    year: truck.year !== null ? String(truck.year) : "",
    vin: truck.vin ?? "",
    status: truck.status,
    currentMileage: truck.current_mileage !== null ? String(truck.current_mileage) : "",
  };
}

export function truckIdentityToPayload(values: TruckIdentityValues): Record<string, unknown> {
  const payload: Record<string, unknown> = { unit_number: values.unitNumber };
  if (values.typeChoice === TRUCK_TYPE_OTHER) {
    if (values.typeCustom.trim()) payload.truck_type = values.typeCustom.trim();
  } else if (values.typeChoice) {
    payload.truck_type = values.typeChoice;
  }
  if (values.make.trim()) payload.make = values.make.trim();
  if (values.model.trim()) payload.model = values.model.trim();
  if (values.year !== "") payload.year = Math.round(Number(values.year));
  if (values.vin.trim()) payload.vin = values.vin.trim();
  payload.status = values.status;
  if (values.currentMileage !== "") {
    payload.current_mileage = Math.round(Number(values.currentMileage));
  }
  return payload;
}

export default function TruckIdentityFields({
  values,
  onChange,
}: {
  values: TruckIdentityValues;
  onChange: (values: TruckIdentityValues) => void;
}) {
  const set = (patch: Partial<TruckIdentityValues>) => onChange({ ...values, ...patch });

  return (
    <fieldset>
      <legend>The truck itself</legend>

      <label htmlFor="unit_number">Unit number</label>
      <input
        id="unit_number"
        value={values.unitNumber}
        onChange={(e) => set({ unitNumber: e.target.value })}
        required
      />

      <label htmlFor="truck_type">Truck type</label>
      <select
        id="truck_type"
        value={values.typeChoice}
        onChange={(e) => set({ typeChoice: e.target.value })}
      >
        <option value="">Not set yet</option>
        {TRUCK_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        <option value={TRUCK_TYPE_OTHER}>Other…</option>
      </select>

      {values.typeChoice === TRUCK_TYPE_OTHER && (
        <>
          <label htmlFor="truck_type_custom">Type — your words</label>
          <input
            id="truck_type_custom"
            value={values.typeCustom}
            onChange={(e) => set({ typeCustom: e.target.value })}
            placeholder="e.g. Flatbed with a liftgate"
          />
        </>
      )}

      <label htmlFor="make">Make</label>
      <input
        id="make"
        value={values.make}
        onChange={(e) => set({ make: e.target.value })}
        placeholder="e.g. Freightliner"
      />

      <label htmlFor="model">Model</label>
      <input
        id="model"
        value={values.model}
        onChange={(e) => set({ model: e.target.value })}
        placeholder="e.g. Cascadia"
      />

      <label htmlFor="year">Year</label>
      <input
        id="year"
        type="number"
        min="1980"
        max="2100"
        value={values.year}
        onChange={(e) => set({ year: e.target.value })}
      />

      <label htmlFor="vin">VIN</label>
      <input id="vin" value={values.vin} onChange={(e) => set({ vin: e.target.value })} />

      <label htmlFor="status">Status</label>
      <select id="status" value={values.status} onChange={(e) => set({ status: e.target.value })}>
        <option value="active">Active</option>
        <option value="maintenance">In maintenance</option>
        <option value="inactive">Inactive</option>
      </select>

      <label htmlFor="current_mileage">Current mileage</label>
      <input
        id="current_mileage"
        type="number"
        min="0"
        step="1"
        value={values.currentMileage}
        onChange={(e) => set({ currentMileage: e.target.value })}
      />
    </fieldset>
  );
}
