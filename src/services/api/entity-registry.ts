// Per-entity knowledge the shared CRUD layer needs but cannot derive
// from a Zod schema: which FK fields point at which parent table, for
// the safeguarded-restore parent checks (Reliability Unit A / A.4
// check 2 - a record may not be restored while a record it references
// is itself deleted, because the composite-FK backstop of Unit E
// cannot see soft-deleted parents, by design).
//
// Labels are the words the 422 refusal uses ("Cannot restore: its
// truck was deleted - restore the truck first"), so they read like the
// UI, not like the schema.

export interface RestoreParent {
  field: string;
  parentTable: string;
  parentLabel: string;
}

const TRUCK: RestoreParent = { field: "truck_id", parentTable: "trucks", parentLabel: "truck" };
const TRAILER: RestoreParent = { field: "trailer_id", parentTable: "trailers", parentLabel: "trailer" };
const DRIVER: RestoreParent = { field: "driver_id", parentTable: "drivers", parentLabel: "driver" };
const LOAD: RestoreParent = { field: "load_id", parentTable: "loads", parentLabel: "load" };
const PHOTO: RestoreParent = {
  field: "photo_document_id",
  parentTable: "documents",
  parentLabel: "photo document",
};

export const RESTORE_PARENTS: Record<string, RestoreParent[]> = {
  trucks: [PHOTO],
  trailers: [PHOTO],
  drivers: [
    { field: "assigned_truck_id", parentTable: "trucks", parentLabel: "truck" },
    PHOTO,
  ],
  loads: [
    TRUCK,
    DRIVER,
    { field: "broker_id", parentTable: "brokers", parentLabel: "broker" },
    { field: "customer_id", parentTable: "customers", parentLabel: "customer" },
  ],
  expenses: [TRUCK, LOAD, DRIVER],
  fuel_purchases: [TRUCK],
  maintenance_events: [TRUCK],
  maintenance_schedules: [TRUCK, TRAILER],
  equipment_checklist_items: [TRUCK, TRAILER],
  pretrip_inspections: [TRUCK, TRAILER, DRIVER],
  duty_logs: [DRIVER, LOAD],
  fund_entries: [LOAD],
  // No FK parents: brokers, customers, account_snapshots,
  // dispatch_exchanges restore on schema validity alone.
};

export function restoreParentsFor(table: string): RestoreParent[] {
  return RESTORE_PARENTS[table] ?? [];
}
