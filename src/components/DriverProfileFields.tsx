"use client";

// UI/UX upgrade: the driver profile field set, shared by Add Driver
// and the driver detail editor. Before this upgrade, Add Driver asked
// for a name and a truck - the phone, role, CDL number, and CDL expiry
// a real profile needs (migration 00027) had no form at all.

import { DRIVER_ROLE_OPTIONS } from "@/lib/fleet-display";
import type { Driver, DriverRole, Truck } from "@/types/entities";

export interface DriverProfileValues {
  name: string;
  phone: string;
  role: string;
  cdlNumber: string;
  cdlExpiresOn: string;
  assignedTruckId: string;
  status: string;
}

export const EMPTY_DRIVER_PROFILE: DriverProfileValues = {
  name: "",
  phone: "",
  role: "",
  cdlNumber: "",
  cdlExpiresOn: "",
  assignedTruckId: "",
  status: "active",
};

export function driverProfileFromDriver(driver: Driver): DriverProfileValues {
  return {
    name: driver.name,
    phone: driver.phone ?? "",
    role: driver.role ?? "",
    cdlNumber: driver.cdl_number ?? "",
    cdlExpiresOn: driver.cdl_expires_on ?? "",
    assignedTruckId: driver.assigned_truck_id ?? "",
    status: driver.status,
  };
}

export function driverProfileToPayload(values: DriverProfileValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: values.name,
    assigned_truck_id: values.assignedTruckId || null,
    status: values.status,
  };
  if (values.phone.trim()) payload.phone = values.phone.trim();
  if (values.role) payload.role = values.role as DriverRole;
  if (values.cdlNumber.trim()) payload.cdl_number = values.cdlNumber.trim();
  if (values.cdlExpiresOn) payload.cdl_expires_on = values.cdlExpiresOn;
  return payload;
}

export default function DriverProfileFields({
  values,
  onChange,
  trucks,
}: {
  values: DriverProfileValues;
  onChange: (values: DriverProfileValues) => void;
  trucks: Truck[];
}) {
  const set = (patch: Partial<DriverProfileValues>) => onChange({ ...values, ...patch });

  return (
    <>
      <label htmlFor="name">Name</label>
      <input id="name" value={values.name} onChange={(e) => set({ name: e.target.value })} required />

      <label htmlFor="role">Role</label>
      <select id="role" value={values.role} onChange={(e) => set({ role: e.target.value })}>
        <option value="">Not set yet</option>
        {DRIVER_ROLE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <label htmlFor="phone">Phone</label>
      <input
        id="phone"
        type="tel"
        value={values.phone}
        onChange={(e) => set({ phone: e.target.value })}
        placeholder="The number dispatch reaches them on"
      />

      <label htmlFor="cdl_number">CDL number</label>
      <input
        id="cdl_number"
        value={values.cdlNumber}
        onChange={(e) => set({ cdlNumber: e.target.value })}
      />

      <label htmlFor="cdl_expires_on">CDL expires</label>
      <input
        id="cdl_expires_on"
        type="date"
        value={values.cdlExpiresOn}
        onChange={(e) => set({ cdlExpiresOn: e.target.value })}
      />

      <label htmlFor="assigned_truck_id">Assigned truck</label>
      <select
        id="assigned_truck_id"
        value={values.assignedTruckId}
        onChange={(e) => set({ assignedTruckId: e.target.value })}
      >
        <option value="">Unassigned</option>
        {trucks.map((truck) => (
          <option key={truck.id} value={truck.id}>
            {truck.unit_number}
          </option>
        ))}
      </select>

      <label htmlFor="status">Status</label>
      <select id="status" value={values.status} onChange={(e) => set({ status: e.target.value })}>
        <option value="active">Active</option>
        <option value="inactive">Inactive</option>
      </select>
    </>
  );
}
