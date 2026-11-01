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

// Smart Path v1 (docs/design/driver-mvp.md §8.2): the known cab
// appliance values. `none` is exclusive - "nothing in the cab" - and
// cannot combine with the others (enforced in the Zod schema).
export type TruckAppliance =
  | "fridge"
  | "cooler"
  | "microwave"
  | "air_fryer"
  | "hot_plate"
  | "coffee_maker"
  | "inverter"
  | "none";

export interface Truck extends BaseRow {
  unit_number: string;
  vin: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  status: EntityStatus;
  current_mileage: number | null;
  // UI/UX upgrade (migration 00027): what kind of truck this is (UI
  // picklist slug or the owner's own words) and the documents row
  // holding its photo. Both null until captured.
  truck_type: string | null;
  photo_document_id: string | null;
  // Truck profile (migration 00017). All optional until captured -
  // the first real profile is Steven's truck, entered by the owner.
  height_in: number | null;
  length_in: number | null;
  weight_lbs: number | null;
  governed_speed_mph: number | null;
  tank_capacity_gallons: number | null;
  avg_mpg: number | null;
  appliances: TruckAppliance[];
  appliance_notes: string | null;
}

export interface Trailer extends BaseRow {
  unit_number: string;
  vin: string | null;
  trailer_type: string | null;
  status: EntityStatus;
  // UI/UX upgrade (migration 00027): the documents row holding its photo.
  photo_document_id: string | null;
}

export type DriverRole = "owner_operator" | "company_driver" | "contract_driver" | "other";

export interface Driver extends BaseRow {
  name: string;
  // UI/UX upgrade (migration 00027): the rest of a real driver profile.
  phone: string | null;
  role: DriverRole | null;
  cdl_number: string | null;
  cdl_expires_on: string | null;
  photo_document_id: string | null;
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

export type MaintenanceScheduleStatus = "active" | "paused";

export interface MaintenanceSchedule extends BaseRow {
  truck_id: string | null;
  trailer_id: string | null;
  description: string;
  interval_miles: number | null;
  interval_days: number | null;
  last_done_date: string | null;
  last_done_mileage: number | null;
  status: MaintenanceScheduleStatus;
}

export interface EquipmentChecklistItem extends BaseRow {
  truck_id: string | null;
  trailer_id: string | null;
  item_name: string;
  quantity_on_hand: number | null;
  last_checked_date: string | null;
  notes: string | null;
}

export interface PretripInspection extends BaseRow {
  truck_id: string | null;
  trailer_id: string | null;
  driver_id: string | null;
  inspected_at: string;
  passed: boolean;
  defects_found: string | null;
}

export type DutyStatus = "off_duty" | "sleeper" | "driving" | "on_duty";

// Driver MVP (docs/design/driver-mvp.md §3): a manual paper-log helper
// row - one per duty-status start. NOT an ELD record.
export interface DutyLog extends BaseRow {
  driver_id: string | null;
  load_id: string | null;
  duty_status: DutyStatus;
  started_at: string;
  location: string | null;
  odometer: number | null;
  notes: string | null;
}

export type DispatchExchangeSource = "web" | "telegram";

// Driver MVP (docs/design/driver-mvp.md §5): one helped dispatch
// exchange - the incoming message, the AI's output, and (when known)
// the reply the owner actually sent.
export interface DispatchExchange extends BaseRow {
  incoming_message: string;
  ai_translation: string | null;
  ai_suggested_reply_en: string | null;
  ai_suggested_reply_es: string | null;
  actual_reply_sent: string | null;
  source: DispatchExchangeSource;
}

export type RelatedEntityType = "truck" | "trailer" | "driver" | "load";

export type DocumentType =
  | "bol"
  | "rate_confirmation"
  | "scale_ticket"
  | "fuel_receipt"
  | "settlement"
  | "other";

export type DocumentExtractionStatus =
  | "pending"
  | "done"
  | "failed"
  | "disabled"
  | "not_applicable";

// Documents don't soft-delete like other entities (docs/schemas.md) - no
// updated_at/deleted_at, so this doesn't extend BaseRow.
export interface Document {
  id: string;
  company_id: string;
  related_entity_type: RelatedEntityType;
  related_entity_id: string;
  file_name: string;
  storage_path: string;
  uploaded_at: string;
  created_at: string;
  // Scan + extraction (docs/design/driver-mvp.md §8, migration 00022).
  scan_storage_path: string | null;
  doc_type: DocumentType | null;
  extracted_text: string | null;
  extracted_fields: Record<string, string | number | null> | null;
  extraction_status: DocumentExtractionStatus;
  extraction_error: string | null;
  extracted_at: string | null;
}

export interface DocumentWithSignedUrl extends Document {
  signed_url: string | null;
  scan_signed_url: string | null;
}

// Truck Fund + money visibility (docs/design/driver-mvp.md §9,
// migration 00023). The enum types live in lib/truck-fund.ts next to
// the math that uses them; these are the row shapes.
import type {
  FundEntryKind,
  FundEntrySource,
  FundKey,
  LadderStepKey,
  LadderStepState,
  MoneyLane,
  SweepMode,
  TruckPriceBandKey,
} from "@/lib/truck-fund";

export type {
  FundEntryKind,
  FundEntrySource,
  FundKey,
  LadderStepKey,
  LadderStepState,
  MoneyLane,
  SweepMode,
  TruckPriceBandKey,
};

export interface FundEntry extends BaseRow {
  fund_key: FundKey;
  kind: FundEntryKind;
  amount_cents: number;
  entry_date: string;
  lane: MoneyLane;
  source: FundEntrySource;
  note: string | null;
  load_id: string | null;
}

export interface FundSettings extends BaseRow {
  sweep_mode: SweepMode;
  sweep_percent: number | null;
  sweep_flat_cents: number | null;
  target_band: TruckPriceBandKey | null;
  target_cents: number | null;
}

export interface BusinessLadderStep extends BaseRow {
  step_key: LadderStepKey;
  state: LadderStepState;
  note: string | null;
}

export interface AccountSnapshot extends BaseRow {
  institution: string;
  account_name: string;
  last4: string;
  balance_cents: number;
  lane: MoneyLane;
  as_of_date: string;
  note: string | null;
}

export type AiConfidence = "high" | "medium" | "low";

// Not part of the shared soft-delete convention: dismissed_at is this
// resource's own "removed from the active list, never erased" field
// (docs/schemas.md), so this doesn't extend BaseRow.
export interface IndustryBriefing {
  id: string;
  company_id: string;
  summary: string;
  reasoning: string;
  confidence: AiConfidence;
  based_on: string[];
  generated_at: string;
  dismissed_at: string | null;
}

// Deep Research Engine (docs/design/research-engine.md, migration
// 00019). Findings/sources/unverified are jsonb arrays with these
// element shapes - validated at generation time by
// services/ai/research-briefing.ts's output contract.
export interface ResearchFinding {
  claim: string;
  source_title: string;
  source_url: string;
}

export interface ResearchSourceRef {
  title: string;
  url: string;
}

export interface ResearchBriefing {
  id: string;
  company_id: string;
  run_id: string | null;
  topic: string;
  title: string;
  headline: string;
  findings: ResearchFinding[];
  what_changed: string;
  counter_move: string;
  takeaway: string;
  unverified: string[];
  sources: ResearchSourceRef[];
  confidence: AiConfidence;
  telegram_notified_at: string | null;
  read_at: string | null;
  dismissed_at: string | null;
  created_at: string;
}

export type ResearchRunStatus =
  | "queued"
  | "running"
  | "success"
  | "failure"
  | "insufficient_data"
  | "skipped_cap"
  | "skipped_disabled";

export interface ResearchRun {
  id: string;
  company_id: string;
  trigger_kind: "scheduled" | "pressure" | "manual";
  topic: string;
  trigger_detail: { reason?: string; signal_dedupe_keys?: string[] };
  status: ResearchRunStatus;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  briefing_id: string | null;
  created_at: string;
}

export interface ResearchWatcherState {
  watcher_key: string;
  last_polled_at: string | null;
  last_status: "ok" | "error" | "skipped" | null;
  last_error: string | null;
  last_signal_at: string | null;
  updated_at: string;
}

// Gaming System (docs/design/gaming-system.md, migrations
// 00024-00026). The target he aims at and the versioned projections
// gamed against it - a plan is a projection, never a promise, and
// nothing here moves money or executes anything.
import type {
  AssumptionEntry,
  DataSufficiency,
  GameMetric,
  GameOutput,
  GamePosture,
  GameSnapshot,
  ValidityViolation,
} from "@/lib/game-plan";

// What services/game actually stores in game_plans.scenarios: the
// engine output plus the §5.5 validity verdict and, when a game had
// to be repaired, what the nearest-valid replacement removed.
export interface StoredGameScenarios extends GameOutput {
  validity: { valid: boolean; violations: ValidityViolation[] };
  removedForValidity: string[];
}

export type { GameMetric, GamePosture };

export interface GameTarget extends BaseRow {
  metric: GameMetric;
  target_value_cents: number;
  target_date: string | null;
  posture: GamePosture;
  posture_mix_pct: number;
  notes: string | null;
  is_active: boolean;
}

export type GamePlanStatus = "current" | "superseded" | "what_if" | "invalid_rules";
export type GamePlanTrigger =
  | "target_set"
  | "target_edit"
  | "checkpoint"
  | "settlement"
  | "fund_milestone"
  | "research_briefing"
  | "maintenance_event"
  | "manual"
  | "what_if";

export interface GamePlan extends BaseRow {
  target_id: string;
  version: number;
  status: GamePlanStatus;
  trigger: GamePlanTrigger;
  snapshot: GameSnapshot;
  assumptions: AssumptionEntry[];
  scenarios: StoredGameScenarios;
  narration: string;
  diff_summary: string | null;
  data_sufficiency: DataSufficiency;
}

export type GamePlanRunStatus =
  | "success"
  | "failure"
  | "skipped_cap"
  | "skipped_disabled"
  | "invalid_replaced";

export interface GamePlanRun extends BaseRow {
  target_id: string | null;
  trigger: GamePlanTrigger;
  status: GamePlanRunStatus;
  plan_id: string | null;
  detail: string | null;
}

export type GameCheckpointVerdict = "on_plan" | "ahead" | "behind" | "no_data";

export interface GameCheckpoint extends BaseRow {
  target_id: string;
  period_month: string;
  planned_value_cents: number;
  actual_value_cents: number | null;
  verdict: GameCheckpointVerdict | null;
  gap_cents: number | null;
  lever_note: string | null;
  telegram_sent_at: string | null;
}

/** GET /api/v1/research-briefings response envelope (docs/api-contracts.md). */
export interface ResearchPageData {
  data: ResearchBriefing[];
  unread_count: number;
  runs: ResearchRun[];
  watchers: ResearchWatcherState[];
  usage: {
    runs_today: number;
    runs_this_month: number;
    max_runs_per_day: number;
    max_runs_per_month: number;
  };
}
