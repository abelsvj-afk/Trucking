// Row types for every MVP entity, matching docs/schemas.md exactly. These
// are the "source of truth shape" until Task 1.2's follow-up
// (`npm run db:generate-types`) replaces/supplements this with a real
// Supabase-generated Database type once that workflow is set up - see
// package.json's db:generate-types script.

export interface BaseRow {
  id: string;
  company_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type EntityStatus = "active" | "maintenance" | "inactive";

export interface Truck extends BaseRow {
  unit_number: string;
  vin: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  status: EntityStatus;
  current_mileage: number | null;
}

export interface Trailer extends BaseRow {
  unit_number: string;
  vin: string | null;
  trailer_type: string | null;
  status: EntityStatus;
}

export interface Driver extends BaseRow {
  name: string;
  cdl_number: string | null;
  assigned_truck_id: string | null;
  status: "active" | "inactive";
}

export interface Customer extends BaseRow {
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
}

export interface Broker extends BaseRow {
  name: string;
  mc_number: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
}

export type LoadStatus = "draft" | "confirmed" | "completed";

export interface Load extends BaseRow {
  truck_id: string | null;
  driver_id: string | null;
  broker_id: string | null;
  customer_id: string | null;
  origin: string;
  destination: string;
  pickup_date: string | null;
  delivery_date: string | null;
  rate_cents: number | null;
  miles: number | null;
  status: LoadStatus;
  notes: string | null;
}

export type ExpenseCategory = "insurance" | "permits" | "repairs" | "other";

export interface Expense extends BaseRow {
  category: ExpenseCategory;
  amount_cents: number;
  expense_date: string;
  truck_id: string | null;
  load_id: string | null;
  driver_id: string | null;
  description: string | null;
}

export interface FuelPurchase extends BaseRow {
  truck_id: string;
  location: string | null;
  gallons: number;
  price_per_gallon_cents: number;
  total_cost_cents: number;
  purchased_at: string;
}

export interface MaintenanceEvent extends BaseRow {
  truck_id: string;
  description: string;
  cost_cents: number | null;
  service_date: string;
  mileage_at_service: number | null;
}
