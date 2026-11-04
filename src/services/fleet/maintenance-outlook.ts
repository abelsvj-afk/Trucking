// The maintenance outlook (Image Intelligence design §5.7): ONE
// computation behind both Abel's maintenance_outlook answer and
// the Phase 4 watcher's digest, so the two can never disagree.
// Per truck: every schedule's due state (through the existing
// computeDueStatus), the mileage's provenance and freshness, and
// the open defects. Unknown is a first-class answer - a schedule
// whose last-done was never recorded says "unknown" and asks
// once; it is never silently treated as fine.

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeDueStatus, type DueStatusResult } from "@/lib/maintenance-schedule";
import { MILEAGE_SOURCE_LABELS, type MileageSource } from "@/services/fleet/mileage";
import { listActiveDefects } from "@/services/fleet/defects";
import { templateByKey } from "@/lib/maintenance-templates";
import type { MaintenanceSchedule, VehicleDefect } from "@/types/entities";

export interface ScheduleOutlook {
  schedule: MaintenanceSchedule;
  vehicleLabel: string;
  due: DueStatusResult;
  safety: boolean;
}

export interface TruckOutlook {
  truckId: string;
  unitNumber: string;
  mileage: number | null;
  mileageSource: MileageSource | null;
  mileageAt: string | null;
  /** Whole days since the mileage was observed; null when never. */
  mileageAgeDays: number | null;
}

export interface MaintenanceOutlook {
  schedules: ScheduleOutlook[];
  trucks: TruckOutlook[];
  defects: VehicleDefect[];
  /** False before migration 00046 lands - stated, never hidden. */
  defectsAvailable: boolean;
  /** False before migration 00046 lands (template columns absent). */
  templateStateAvailable: boolean;
}

interface TruckRow {
  id: string;
  unit_number: string;
  current_mileage: number | null;
  current_mileage_source: MileageSource | null;
  current_mileage_at: string | null;
}

interface TrailerRow {
  id: string;
  unit_number: string;
}

const SCHEDULE_COLS =
  "id, company_id, truck_id, trailer_id, description, interval_miles, interval_days, last_done_date, last_done_mileage, status, template_key, origin, last_reminded_at, last_reminder_key, created_at, updated_at, deleted_at";
const SCHEDULE_COLS_LEGACY =
  "id, company_id, truck_id, trailer_id, description, interval_miles, interval_days, last_done_date, last_done_mileage, status, created_at, updated_at, deleted_at";

export async function computeMaintenanceOutlook(
  client: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<MaintenanceOutlook> {
  const today = now.toISOString().slice(0, 10);

  const trucksResult = await client
    .from("trucks")
    .select("id, unit_number, current_mileage, current_mileage_source, current_mileage_at")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .order("unit_number", { ascending: true });
  let truckRows: TruckRow[];
  if (trucksResult.error) {
    // Pre-00045 the provenance columns are absent; mileage still reads.
    if (!/does not exist/i.test(trucksResult.error.message)) {
      throw new Error(trucksResult.error.message);
    }
    const retry = await client
      .from("trucks")
      .select("id, unit_number, current_mileage")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .order("unit_number", { ascending: true });
    if (retry.error) throw new Error(retry.error.message);
    truckRows = ((retry.data ?? []) as Omit<TruckRow, "current_mileage_source" | "current_mileage_at">[]).map(
      (row) => ({ ...row, current_mileage_source: null, current_mileage_at: null }),
    );
  } else {
    truckRows = (trucksResult.data ?? []) as TruckRow[];
  }

  const trailersResult = await client
    .from("trailers")
    .select("id, unit_number")
    .eq("company_id", companyId)
    .is("deleted_at", null);
  if (trailersResult.error) throw new Error(trailersResult.error.message);
  const trailerRows = (trailersResult.data ?? []) as TrailerRow[];

  let templateStateAvailable = true;
  type QueryResult = { data: unknown; error: { message: string } | null };
  let schedulesResult = (await client
    .from("maintenance_schedules")
    .select(SCHEDULE_COLS)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .order("description", { ascending: true })) as unknown as QueryResult;
  if (schedulesResult.error) {
    if (/does not exist/i.test(schedulesResult.error.message)) {
      templateStateAvailable = false;
      schedulesResult = (await client
        .from("maintenance_schedules")
        .select(SCHEDULE_COLS_LEGACY)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .order("description", { ascending: true })) as unknown as QueryResult;
    }
    if (schedulesResult.error) throw new Error(schedulesResult.error.message);
  }
  const scheduleRows = ((schedulesResult.data ?? []) as Partial<MaintenanceSchedule>[]).map(
    (row) =>
      ({
        ...row,
        template_key: row.template_key ?? null,
        origin: row.origin ?? "owner",
        last_reminded_at: row.last_reminded_at ?? null,
        last_reminder_key: row.last_reminder_key ?? null,
      }) as MaintenanceSchedule,
  );

  const truckById = new Map(truckRows.map((t) => [t.id, t]));
  const trailerById = new Map(trailerRows.map((t) => [t.id, t]));

  const schedules: ScheduleOutlook[] = scheduleRows.map((schedule) => {
    const truck = schedule.truck_id ? truckById.get(schedule.truck_id) : undefined;
    const trailer = schedule.trailer_id ? trailerById.get(schedule.trailer_id) : undefined;
    const vehicleLabel = truck
      ? `truck ${truck.unit_number}`
      : trailer
        ? `trailer ${trailer.unit_number}`
        : "a vehicle no longer on file";
    return {
      schedule,
      vehicleLabel,
      due: computeDueStatus(schedule, truck?.current_mileage ?? null, today),
      safety: templateByKey(schedule.template_key)?.safety ?? false,
    };
  });

  const trucks: TruckOutlook[] = truckRows.map((truck) => ({
    truckId: truck.id,
    unitNumber: truck.unit_number,
    mileage: truck.current_mileage,
    mileageSource: truck.current_mileage_source,
    mileageAt: truck.current_mileage_at,
    mileageAgeDays:
      truck.current_mileage_at != null
        ? Math.floor((now.getTime() - new Date(truck.current_mileage_at).getTime()) / 86_400_000)
        : null,
  }));

  const { defects, available } = await listActiveDefects(client, companyId);

  return { schedules, trucks, defects, defectsAvailable: available, templateStateAvailable };
}

function fmtMiles(miles: number): string {
  return Math.round(miles).toLocaleString("en-US");
}

function duePhrase(entry: ScheduleOutlook): string {
  const { due } = entry;
  const bits: string[] = [];
  if (due.nextDueDate) bits.push(`by ${due.nextDueDate}`);
  if (due.nextDueMileage != null) bits.push(`at ${fmtMiles(due.nextDueMileage)} mi`);
  return bits.length > 0 ? ` (due ${bits.join(" / ")})` : "";
}

/** The owner's maintenance answer, in Abel's voice - the read tool's text. */
export function formatMaintenanceOutlook(outlook: MaintenanceOutlook): string {
  const lines: string[] = [];
  const byStatus = (status: string) => outlook.schedules.filter((s) => s.due.status === status);

  const overdue = byStatus("overdue");
  const dueSoon = byStatus("due-soon");
  const unknown = byStatus("unknown");
  const ok = byStatus("ok");
  const paused = byStatus("paused");

  if (outlook.schedules.length === 0) {
    lines.push("No maintenance schedules are set up yet - nothing is being tracked, so nothing can be called due.");
  }
  for (const entry of overdue) {
    lines.push(`OVERDUE: ${entry.schedule.description} on ${entry.vehicleLabel}${duePhrase(entry)}.`);
  }
  for (const entry of dueSoon) {
    lines.push(`Due soon: ${entry.schedule.description} on ${entry.vehicleLabel}${duePhrase(entry)}.`);
  }
  for (const entry of unknown) {
    lines.push(
      `Unknown: ${entry.schedule.description} on ${entry.vehicleLabel} - no last-done on record, so I can't tell when it's due. Tell me when it was last done and I'll track it from there.`,
    );
  }
  for (const entry of ok) {
    lines.push(`On track: ${entry.schedule.description} on ${entry.vehicleLabel}${duePhrase(entry)}.`);
  }
  for (const entry of paused) {
    lines.push(`Paused: ${entry.schedule.description} on ${entry.vehicleLabel}.`);
  }

  for (const truck of outlook.trucks) {
    if (truck.mileage == null) {
      lines.push(`Truck ${truck.unitNumber}: no mileage recorded yet.`);
    } else {
      const source = truck.mileageSource ? MILEAGE_SOURCE_LABELS[truck.mileageSource] : null;
      lines.push(
        `Truck ${truck.unitNumber}: ${fmtMiles(truck.mileage)} mi` +
          (source ? ` (from ${source}${truck.mileageAgeDays != null ? `, ${truck.mileageAgeDays} day${truck.mileageAgeDays === 1 ? "" : "s"} ago` : ""})` : " (source not recorded)"),
      );
    }
  }

  if (!outlook.defectsAvailable) {
    lines.push("Defect tracking isn't live in the database yet (it arrives with the maintenance update).");
  } else if (outlook.defects.length > 0) {
    lines.push(`Open defects (${outlook.defects.length}):`);
    for (const defect of outlook.defects) {
      lines.push(`- ${defect.description} (${defect.status}, first noted ${defect.created_at.slice(0, 10)})`);
    }
  }

  return lines.join("\n");
}
