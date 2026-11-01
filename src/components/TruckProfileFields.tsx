"use client";

// Smart Path v1 (docs/design/driver-mvp.md §8.2). The truck-profile
// field set, shared by the New Truck form and the Fleet → Truck
// profile editor so the two can never drift into different shapes.
// Values are kept as strings (plus the appliances array) and parsed
// by truckProfileToPayload() at submit time; empty means "not
// captured yet", which is a real state - nothing here invents a
// default dimension for a truck nobody has measured.

import type { TruckAppliance } from "@/types/entities";

export interface TruckProfileValues {
  heightFt: string;
  heightIn: string;
  lengthFt: string;
  weightLbs: string;
  governedSpeedMph: string;
  tankCapacityGallons: string;
  avgMpg: string;
  appliances: TruckAppliance[];
  applianceNotes: string;
}

export const EMPTY_TRUCK_PROFILE: TruckProfileValues = {
  heightFt: "",
  heightIn: "",
  lengthFt: "",
  weightLbs: "",
  governedSpeedMph: "",
  tankCapacityGallons: "",
  avgMpg: "",
  appliances: [],
  applianceNotes: "",
};

export const APPLIANCE_LABELS: { value: TruckAppliance; label: string }[] = [
  { value: "fridge", label: "Fridge" },
  { value: "cooler", label: "Cooler" },
  { value: "microwave", label: "Microwave" },
  { value: "air_fryer", label: "Air fryer" },
  { value: "hot_plate", label: "Hot plate" },
  { value: "coffee_maker", label: "Coffee maker" },
  { value: "inverter", label: "Inverter" },
  { value: "none", label: "None — nothing in the cab" },
];

// The reverse direction, for editors that start from an existing
// truck (Fleet → Truck profile, and the truck detail screen from the
// UI/UX upgrade) - one conversion, shared, so every editor opens with
// the same values for the same truck.
export function truckProfileFromTruck(truck: {
  height_in: number | null;
  length_in: number | null;
  weight_lbs: number | null;
  governed_speed_mph: number | null;
  tank_capacity_gallons: number | null;
  avg_mpg: number | null;
  appliances: TruckAppliance[] | null;
  appliance_notes: string | null;
}): TruckProfileValues {
  return {
    heightFt: truck.height_in !== null ? String(Math.floor(truck.height_in / 12)) : "",
    heightIn: truck.height_in !== null ? String(truck.height_in % 12) : "",
    lengthFt: truck.length_in !== null ? String(truck.length_in / 12) : "",
    weightLbs: truck.weight_lbs !== null ? String(truck.weight_lbs) : "",
    governedSpeedMph: truck.governed_speed_mph !== null ? String(truck.governed_speed_mph) : "",
    tankCapacityGallons:
      truck.tank_capacity_gallons !== null ? String(truck.tank_capacity_gallons) : "",
    avgMpg: truck.avg_mpg !== null ? String(truck.avg_mpg) : "",
    appliances: truck.appliances ?? [],
    applianceNotes: truck.appliance_notes ?? "",
  };
}

export function truckProfileToPayload(values: TruckProfileValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const heightFt = Number(values.heightFt);
  const heightIn = Number(values.heightIn);
  if (values.heightFt !== "" || values.heightIn !== "") {
    payload.height_in = Math.round((Number.isFinite(heightFt) ? heightFt : 0) * 12 + (Number.isFinite(heightIn) ? heightIn : 0));
  }
  if (values.lengthFt !== "") payload.length_in = Math.round(Number(values.lengthFt) * 12);
  if (values.weightLbs !== "") payload.weight_lbs = Math.round(Number(values.weightLbs));
  if (values.governedSpeedMph !== "") payload.governed_speed_mph = Math.round(Number(values.governedSpeedMph));
  if (values.tankCapacityGallons !== "") payload.tank_capacity_gallons = Number(values.tankCapacityGallons);
  if (values.avgMpg !== "") payload.avg_mpg = Number(values.avgMpg);
  payload.appliances = values.appliances;
  if (values.applianceNotes !== "") payload.appliance_notes = values.applianceNotes;
  return payload;
}

interface TruckProfileFieldsProps {
  values: TruckProfileValues;
  onChange: (values: TruckProfileValues) => void;
}

export default function TruckProfileFields({ values, onChange }: TruckProfileFieldsProps) {
  const set = (patch: Partial<TruckProfileValues>) => onChange({ ...values, ...patch });

  function toggleAppliance(appliance: TruckAppliance) {
    if (appliance === "none") {
      set({ appliances: values.appliances.includes("none") ? [] : ["none"] });
      return;
    }
    const without = values.appliances.filter((a) => a !== "none" && a !== appliance);
    set({
      appliances: values.appliances.includes(appliance) ? without : [...without, appliance],
    });
  }

  return (
    <fieldset>
      <legend>Truck profile — size, speed, and what&apos;s in the cab (Smart Path plans from this)</legend>

      <label htmlFor="height_ft">Height — feet</label>
      <input id="height_ft" type="number" min="0" value={values.heightFt} onChange={(e) => set({ heightFt: e.target.value })} />
      <label htmlFor="height_in">Height — inches</label>
      <input id="height_in" type="number" min="0" max="11" value={values.heightIn} onChange={(e) => set({ heightIn: e.target.value })} />

      <label htmlFor="length_ft">Length — feet (truck + trailer)</label>
      <input id="length_ft" type="number" min="0" step="0.5" value={values.lengthFt} onChange={(e) => set({ lengthFt: e.target.value })} />

      <label htmlFor="weight_lbs">Weight — pounds (loaded, typical)</label>
      <input id="weight_lbs" type="number" min="0" step="100" value={values.weightLbs} onChange={(e) => set({ weightLbs: e.target.value })} />

      <label htmlFor="governed_speed">Governed speed — mph</label>
      <input id="governed_speed" type="number" min="20" max="100" value={values.governedSpeedMph} onChange={(e) => set({ governedSpeedMph: e.target.value })} />

      <label htmlFor="tank_gallons">Tank capacity — gallons</label>
      <input id="tank_gallons" type="number" min="0" step="1" value={values.tankCapacityGallons} onChange={(e) => set({ tankCapacityGallons: e.target.value })} />

      <label htmlFor="avg_mpg">Average fuel economy — mpg</label>
      <input id="avg_mpg" type="number" min="2" max="20" step="0.1" value={values.avgMpg} onChange={(e) => set({ avgMpg: e.target.value })} />

      <fieldset>
        <legend>Appliances in the cab — what can you cook or store food with?</legend>
        {APPLIANCE_LABELS.map(({ value, label }) => (
          <label key={value}>
            <input
              type="checkbox"
              checked={values.appliances.includes(value)}
              onChange={() => toggleAppliance(value)}
            />{" "}
            {label}
          </label>
        ))}
      </fieldset>

      <label htmlFor="appliance_notes">Appliance notes (inverter watts, cooler size…)</label>
      <input
        id="appliance_notes"
        value={values.applianceNotes}
        onChange={(e) => set({ applianceNotes: e.target.value })}
      />
    </fieldset>
  );
}
