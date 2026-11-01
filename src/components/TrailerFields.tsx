"use client";

// UI/UX upgrade: the trailer field set, shared by Add Trailer and the
// trailer detail editor. The Add Trailer form previously asked for a
// unit number and nothing else - the schema's type/VIN/status fields
// existed with no way to fill them in.

import type { Trailer } from "@/types/entities";

export interface TrailerValues {
  unitNumber: string;
  trailerType: string;
  vin: string;
  status: string;
}

export const EMPTY_TRAILER: TrailerValues = {
  unitNumber: "",
  trailerType: "",
  vin: "",
  status: "active",
};

export function trailerFromTrailer(trailer: Trailer): TrailerValues {
  return {
    unitNumber: trailer.unit_number,
    trailerType: trailer.trailer_type ?? "",
    vin: trailer.vin ?? "",
    status: trailer.status,
  };
}

export function trailerToPayload(values: TrailerValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    unit_number: values.unitNumber,
    status: values.status,
  };
  if (values.trailerType.trim()) payload.trailer_type = values.trailerType.trim();
  if (values.vin.trim()) payload.vin = values.vin.trim();
  return payload;
}

// Common trailer kinds for the datalist - suggestions, not a cage:
// trailer_type is free text, so anything the owner types is kept.
export const TRAILER_TYPE_SUGGESTIONS = [
  "Dry van",
  "Reefer",
  "Flatbed",
  "Step deck",
  "Tanker",
  "Car hauler",
  "Lowboy",
  "Dump",
];

export default function TrailerFields({
  values,
  onChange,
}: {
  values: TrailerValues;
  onChange: (values: TrailerValues) => void;
}) {
  const set = (patch: Partial<TrailerValues>) => onChange({ ...values, ...patch });

  return (
    <>
      <label htmlFor="unit_number">Unit number</label>
      <input
        id="unit_number"
        value={values.unitNumber}
        onChange={(e) => set({ unitNumber: e.target.value })}
        required
      />

      <label htmlFor="trailer_type">Trailer type</label>
      <input
        id="trailer_type"
        value={values.trailerType}
        onChange={(e) => set({ trailerType: e.target.value })}
        list="trailer-type-suggestions"
        placeholder="e.g. Dry van, Reefer, Flatbed"
      />
      <datalist id="trailer-type-suggestions">
        {TRAILER_TYPE_SUGGESTIONS.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>

      <label htmlFor="vin">VIN</label>
      <input id="vin" value={values.vin} onChange={(e) => set({ vin: e.target.value })} />

      <label htmlFor="status">Status</label>
      <select id="status" value={values.status} onChange={(e) => set({ status: e.target.value })}>
        <option value="active">Active</option>
        <option value="maintenance">In maintenance</option>
        <option value="inactive">Inactive</option>
      </select>
    </>
  );
}
