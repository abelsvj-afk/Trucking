// The fleet-upkeep write tools: maintenance events and schedules, vehicle
// defects and the standard pack, checklist items and pre-trip inspections.
// Split out of tools-write.ts (decomposition pass, behavior unchanged): the same
// tools, pushed onto the same list in the same order.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { changedFields, dateString, idParam, makeCreateTool, makeUpdateTool, uuid, type Row } from "./tools-write-helpers";
import { definedOnly, dollars, fetchLiveRow, patchLiveRow, validateWith } from "./tool-helpers";
import { createMaintenanceEventSchema, updateMaintenanceEventSchema } from "@/data/schemas/maintenance-events";
import { createMaintenanceScheduleSchema, updateMaintenanceScheduleSchema } from "@/data/schemas/maintenance-schedules";
import { createEquipmentChecklistItemSchema, updateEquipmentChecklistItemSchema } from "@/data/schemas/equipment-checklist-items";
import { createPretripInspectionSchema } from "@/data/schemas/pretrip-inspections";
import { propagateMileage } from "@/services/fleet/mileage";
import { createVehicleDefectSchema, updateVehicleDefectSchema } from "@/data/schemas/vehicle-defects";
import { defectMatchesWork, listActiveDefects, splitDefectTexts, stageDefectProposals } from "@/services/fleet/defects";
import { stageMaintenancePack } from "@/services/fleet/maintenance-seeding";
import { guessTemplateKey } from "@/lib/maintenance-templates";

export function pushMaintenanceTools(store: BotBrainStore, tools: AgentTool[]): void {
  // --- Maintenance ---------------------------------------------------

  tools.push(
    makeCreateTool(store, {
      name: "create_maintenance_event",
      description: "Record maintenance/repair work that was done on a truck (Maintenance tab): what, when, what it cost. Pass template_key when the work matches the standard library (engine_oil, fuel_filters, chassis_lube, brake_inspection, air_filter, tire_inspection, coolant_test, belt_hose_inspect, dot_annual, dpf_service, trans_diff_fluid) - it pairs the event with its schedule so the schedule advances in the same approval (§5.4).",
      parameters: {
        type: "object",
        properties: {
          truck_id: idParam("truck_id", "truck"),
          description: { type: "string" },
          cost_dollars: { type: "number" },
          service_date: { type: "string", description: "YYYY-MM-DD" },
          mileage_at_service: { type: "number" },
          template_key: { type: "string", description: "Standard-library key for this work, when it matches one (see the list in the description)." },
        },
        required: ["truck_id", "description", "service_date"],
      },
      botSchema: z.object({
        truck_id: uuid,
        description: z.string().min(1),
        cost_dollars: z.number().nonnegative().nullable().optional(),
        service_date: dateString,
        mileage_at_service: z.number().int().nonnegative().nullable().optional(),
        template_key: z.string().min(1).max(60).optional(),
      }),
      table: "maintenance_events",
      label: "maintenance event",
      toRow: (args) => {
        // template_key is pairing metadata (§5.4), not an events column.
        const { cost_dollars, template_key: _templateKey, ...rest } = definedOnly(args);
        const row: Row = { ...rest };
        if (cost_dollars !== undefined) {
          row.cost_cents = cost_dollars === null ? null : Math.round(Number(cost_dollars) * 100);
        }
        return row;
      },
      rowSchema: createMaintenanceEventSchema,
      summarize: (args) =>
        `Maintenance: ${args.description} on ${args.service_date}` +
        `${typeof args.cost_dollars === "number" ? ` — ${dollars(Math.round(args.cost_dollars * 100))}` : ""}`,
      confirm: (args) => `Recorded maintenance: ${args.description}.`,
      // §5.3: a service mileage is an observation of the truck's
      // odometer - it flows into current_mileage through the one
      // propagation door (never backwards, provenance stamped).
      // §5.5: the same landing SUGGESTS defect closures it sounds
      // like - the closure itself is always a separate proposal.
      afterCreate: async (args, eventId) => {
        let note = "";
        const miles = args.mileage_at_service;
        if (typeof miles === "number") {
          const outcome = await propagateMileage(store.client, store.companyId, {
            truckId: String(args.truck_id),
            miles,
            source: "maintenance_event",
          });
          if (outcome.applied) {
            note += ` Truck mileage now ${Math.round(miles).toLocaleString("en-US")} (from this service record).`;
          } else if (outcome.reason === "not_forward") {
            note += ` The truck's recorded mileage (${outcome.previousMiles?.toLocaleString("en-US")}) is already past this service mileage, so it stays.`;
          }
        }
        try {
          const { defects, available } = await listActiveDefects(store.client, store.companyId);
          if (available) {
            const matches = defects.filter(
              (d) => d.truck_id === String(args.truck_id) && defectMatchesWork(d, String(args.description)),
            );
            for (const match of matches) {
              note += ` That sounds like the fix for the open defect "${match.description}" (defect ${match.id}, event ${eventId}) - if it is, stage its closure with resolve_vehicle_defect and let him approve it; don't close it silently.`;
            }
          }
        } catch (err) {
          console.error("[tools-write] defect closure suggestion failed:", err);
        }
        // §5.4, executed path: proposal pairing doesn't run when
        // the event was ordered directly, so if its schedule is
        // still behind, say so - the completion stays a proposal
        // he approves, never a silent side effect.
        try {
          const key =
            (typeof args.template_key === "string" ? args.template_key : null) ??
            guessTemplateKey(String(args.description));
          if (key) {
            const { data } = await store.client
              .from("maintenance_schedules")
              .select("description, last_done_date")
              .eq("company_id", store.companyId)
              .eq("truck_id", String(args.truck_id))
              .eq("template_key", key)
              .eq("status", "active")
              .is("deleted_at", null)
              .limit(1);
            const schedule = ((data ?? []) as { description: string; last_done_date: string | null }[])[0];
            if (schedule && (schedule.last_done_date == null || schedule.last_done_date < String(args.service_date))) {
              note += ` The "${schedule.description}" schedule still shows ${schedule.last_done_date ? `last done ${schedule.last_done_date}` : "no last-done"} - tell me to mark it done and I'll stage that completion for your yes.`;
            }
          }
        } catch (err) {
          console.error("[tools-write] schedule advance note failed:", err);
        }
        return note || undefined;
      },
    }),
    makeUpdateTool(store, {
      name: "update_maintenance_event",
      description: "Correct a maintenance event already recorded.",
      parameters: {
        type: "object",
        properties: {
          event_id: idParam("event_id", "maintenance event"),
          description: { type: "string" },
          cost_dollars: { type: "number" },
          service_date: { type: "string", description: "YYYY-MM-DD" },
          mileage_at_service: { type: "number" },
        },
        required: ["event_id"],
      },
      botSchema: z.object({
        event_id: uuid,
        description: z.string().min(1).optional(),
        cost_dollars: z.number().nonnegative().nullable().optional(),
        service_date: dateString.optional(),
        mileage_at_service: z.number().int().nonnegative().nullable().optional(),
      }),
      table: "maintenance_events",
      label: "maintenance event",
      idKey: "event_id",
      toPatch: (args) => {
        const { cost_dollars, ...rest } = definedOnly(args);
        const patch: Row = { ...rest };
        if (cost_dollars !== undefined) {
          patch.cost_cents = cost_dollars === null ? null : Math.round(Number(cost_dollars) * 100);
        }
        return patch;
      },
      patchSchema: updateMaintenanceEventSchema,
      summarize: (args) => `Update maintenance event ${args.event_id}: ${changedFields(args, "event_id")}`,
      confirm: (args) => `Updated maintenance event ${args.event_id} (${changedFields(args, "event_id")}).`,
    }),
    makeCreateTool(store, {
      name: "create_maintenance_schedule",
      description:
        "Set up a preventative-maintenance schedule (e.g. oil change every 10,000 miles, pigtail inspection every 30 days) for exactly one truck or trailer, with at least one interval. template_key + origin='template' are for the standard-pack staging (§5.2) - schedules you set up from his words take origin 'abel' unless he dictated it as his own standing setup.",
      parameters: {
        type: "object",
        properties: {
          truck_id: { type: "string" },
          trailer_id: { type: "string" },
          description: { type: "string" },
          interval_miles: { type: "number" },
          interval_days: { type: "number" },
          last_done_date: { type: "string", description: "YYYY-MM-DD" },
          last_done_mileage: { type: "number" },
          status: { type: "string", enum: ["active", "paused"] },
          template_key: { type: "string", description: "Standard-library key when this schedule comes from the pack." },
          origin: { type: "string", enum: ["template", "owner", "abel"] },
        },
        required: ["description"],
      },
      botSchema: createMaintenanceScheduleSchema,
      table: "maintenance_schedules",
      label: "maintenance schedule",
      toRow: (args) => definedOnly(args),
      rowSchema: createMaintenanceScheduleSchema,
      summarize: (args) => `Maintenance schedule: ${args.description}`,
      confirm: (args) => `Created maintenance schedule: ${args.description}.`,
    }),
    makeUpdateTool(store, {
      name: "update_maintenance_schedule",
      description: "Update a maintenance schedule (description, intervals, last-done, or pause/resume via status).",
      parameters: {
        type: "object",
        properties: {
          schedule_id: idParam("schedule_id", "maintenance schedule"),
          description: { type: "string" },
          interval_miles: { type: "number" },
          interval_days: { type: "number" },
          last_done_date: { type: "string", description: "YYYY-MM-DD" },
          last_done_mileage: { type: "number" },
          status: { type: "string", enum: ["active", "paused"] },
        },
        required: ["schedule_id"],
      },
      botSchema: z.object({
        schedule_id: uuid,
        description: z.string().min(1).optional(),
        interval_miles: z.number().int().positive().nullable().optional(),
        interval_days: z.number().int().positive().nullable().optional(),
        last_done_date: z.string().nullable().optional(),
        last_done_mileage: z.number().int().nonnegative().nullable().optional(),
        status: z.enum(["active", "paused"]).optional(),
      }),
      table: "maintenance_schedules",
      label: "maintenance schedule",
      idKey: "schedule_id",
      toPatch: (args) => definedOnly(args),
      patchSchema: updateMaintenanceScheduleSchema,
      mergedSchema: createMaintenanceScheduleSchema,
      summarize: (args) => `Update maintenance schedule ${args.schedule_id}: ${changedFields(args, "schedule_id")}`,
      confirm: (args) => `Updated maintenance schedule ${args.schedule_id} (${changedFields(args, "schedule_id")}).`,
    }),
    {
      name: "complete_maintenance_schedule",
      description:
        "Mark a maintenance schedule as done now (the work was performed): sets its last-done date (today unless he names one) and last-done mileage (his figure, or the truck's current mileage when known).",
      parameters: {
        type: "object",
        properties: {
          schedule_id: idParam("schedule_id", "maintenance schedule"),
          done_date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
          done_mileage: { type: "number" },
        },
        required: ["schedule_id"],
      },
      access: "write",
      validateArgs: validateWith(
        z.object({ schedule_id: uuid, done_date: dateString.optional(), done_mileage: z.number().int().nonnegative().optional() }),
      ),
      summarize: (args) => `Mark maintenance schedule ${args.schedule_id} done${args.done_date ? ` on ${args.done_date}` : " today"}`,
      async run(args) {
        const parsed = z
          .object({ schedule_id: uuid, done_date: dateString.optional(), done_mileage: z.number().int().nonnegative().optional() })
          .parse(args) as Row;
        const { client, companyId } = store;
        const schedule = await fetchLiveRow(client, "maintenance_schedules", companyId, String(parsed.schedule_id), "maintenance schedule");
        const patch: Row = {
          last_done_date: typeof parsed.done_date === "string" ? parsed.done_date : new Date().toISOString().slice(0, 10),
        };
        if (typeof parsed.done_mileage === "number") {
          patch.last_done_mileage = parsed.done_mileage;
        } else if (typeof schedule.truck_id === "string") {
          const truck = await fetchLiveRow(client, "trucks", companyId, schedule.truck_id, "truck").catch(() => null);
          if (truck && typeof truck.current_mileage === "number") patch.last_done_mileage = truck.current_mileage;
        }
        updateMaintenanceScheduleSchema.parse(patch);
        await patchLiveRow(client, "maintenance_schedules", companyId, String(parsed.schedule_id), patch);
        return `Marked "${schedule.description}" done (last done ${patch.last_done_date}${patch.last_done_mileage != null ? ` at ${patch.last_done_mileage} mi` : ""}).`;
      },
    },
  );

  // --- Vehicle defects + the standard pack (§5.5 / §5.2) -------------

  tools.push(
    makeCreateTool(store, {
      name: "create_vehicle_defect",
      description:
        "Track an observed problem on exactly one truck or trailer (a defect - not work done, not future work): from a failed pre-trip, a damage photo, or his words. It stays open until a matching maintenance event closes it (via resolve_vehicle_defect) or he dismisses it - dismissal is permanent, the watcher never asks about it again.",
      parameters: {
        type: "object",
        properties: {
          truck_id: { type: "string" },
          trailer_id: { type: "string" },
          description: { type: "string", description: "The problem, in his words where possible." },
          source: { type: "string", enum: ["pretrip", "photo", "conversation"] },
          source_inspection_id: { type: "string", description: "The failed pre-trip's id, when that's where it came from." },
          source_document_id: { type: "string", description: "The damage photo's documents id, when that's where it came from." },
        },
        required: ["description", "source"],
      },
      botSchema: createVehicleDefectSchema,
      table: "vehicle_defects",
      label: "vehicle defect",
      toRow: (args) => definedOnly(args),
      rowSchema: createVehicleDefectSchema,
      summarize: (args) => `Defect (${args.source}): ${args.description}`,
      confirm: (args) => `Tracking the defect: ${args.description}.`,
    }),
    {
      name: "resolve_vehicle_defect",
      description:
        "Move a tracked defect forward: 'acknowledged' (he's seen it), 'closed' (fixed - pass maintenance_event_id when a recorded event is the fix), or 'dismissed' (not his problem / not worth tracking - permanent, never re-asked).",
      parameters: {
        type: "object",
        properties: {
          defect_id: idParam("defect_id", "vehicle defect"),
          status: { type: "string", enum: ["acknowledged", "closed", "dismissed"] },
          maintenance_event_id: { type: "string", description: "The maintenance event that fixed it, when closing." },
        },
        required: ["defect_id", "status"],
      },
      access: "write",
      validateArgs: validateWith(
        z.object({
          defect_id: uuid,
          status: z.enum(["acknowledged", "closed", "dismissed"]),
          maintenance_event_id: uuid.optional(),
        }),
      ),
      summarize: (args) => `Defect ${args.defect_id}: mark ${args.status}`,
      async run(args) {
        const parsed = z
          .object({
            defect_id: uuid,
            status: z.enum(["acknowledged", "closed", "dismissed"]),
            maintenance_event_id: uuid.optional(),
          })
          .parse(args) as Row;
        const { client, companyId } = store;
        const defect = await fetchLiveRow(client, "vehicle_defects", companyId, String(parsed.defect_id), "vehicle defect");
        const patch: Row = { status: parsed.status, updated_at: new Date().toISOString() };
        if (typeof parsed.maintenance_event_id === "string") {
          patch.maintenance_event_id = parsed.maintenance_event_id;
        }
        updateVehicleDefectSchema.parse(patch);
        await patchLiveRow(client, "vehicle_defects", companyId, String(parsed.defect_id), patch);
        return `Defect "${defect.description}" marked ${String(parsed.status)}${parsed.status === "dismissed" ? " - it won't be raised again" : ""}.`;
      },
    },
    {
      name: "propose_maintenance_pack",
      description:
        "Stage the standard maintenance-schedule pack for a truck (§5.2): the interval library (oil, filters, brakes, DOT annual...) as one approval batch. Call it when a truck is new to the app or he asks what maintenance he should be tracking. It stages proposals only - nothing is recorded until he says yes - and the tool itself reports when the pack was already proposed or fully tracked.",
      parameters: {
        type: "object",
        properties: { truck_id: idParam("truck_id", "truck") },
        required: ["truck_id"],
      },
      access: "write",
      validateArgs: validateWith(z.object({ truck_id: uuid })),
      summarize: (args) => `Propose the standard maintenance pack for truck ${args.truck_id}`,
      async run(args) {
        const parsed = z.object({ truck_id: uuid }).parse(args);
        const outcome = await stageMaintenancePack(store, parsed.truck_id);
        return outcome.text;
      },
    },
  );

  // --- Checklist items + inspections ---------------------------------

  const checklistParams = {
    truck_id: { type: "string" },
    trailer_id: { type: "string" },
    item_name: { type: "string" },
    quantity_on_hand: { type: "number" },
    last_checked_date: { type: "string", description: "YYYY-MM-DD" },
    notes: { type: "string" },
  };
  tools.push(
    makeCreateTool(store, {
      name: "create_checklist_item",
      description: "Add an equipment checklist item (a spare/tool that should be on board) for exactly one truck or trailer.",
      parameters: { type: "object", properties: checklistParams, required: ["item_name"] },
      botSchema: createEquipmentChecklistItemSchema,
      table: "equipment_checklist_items",
      label: "checklist item",
      toRow: (args) => definedOnly(args),
      rowSchema: createEquipmentChecklistItemSchema,
      summarize: (args) => `Checklist item: ${args.item_name}`,
      confirm: (args) => `Added checklist item ${args.item_name}.`,
    }),
    makeUpdateTool(store, {
      name: "update_checklist_item",
      description:
        "Update a checklist item (name, quantity on hand, notes) - or set mark_checked true to stamp it checked today (that's how a completed equipment check gets recorded).",
      parameters: {
        type: "object",
        properties: {
          item_id: idParam("item_id", "checklist item"),
          ...checklistParams,
          mark_checked: { type: "boolean", description: "Stamp last_checked_date as today." },
        },
        required: ["item_id"],
      },
      botSchema: z.object({
        item_id: uuid,
        item_name: z.string().min(1).optional(),
        quantity_on_hand: z.number().int().nonnegative().nullable().optional(),
        last_checked_date: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        mark_checked: z.boolean().optional(),
      }),
      table: "equipment_checklist_items",
      label: "checklist item",
      idKey: "item_id",
      toPatch: (args) => {
        const { mark_checked, ...rest } = definedOnly(args);
        const patch: Row = { ...rest };
        if (mark_checked === true) patch.last_checked_date = new Date().toISOString().slice(0, 10);
        return patch;
      },
      patchSchema: updateEquipmentChecklistItemSchema,
      summarize: (args) =>
        `Update checklist item ${args.item_id}: ${changedFields(args, "item_id")}${args.mark_checked ? " (mark checked today)" : ""}`,
      confirm: (args) => `Updated checklist item ${args.item_id} (${changedFields(args, "item_id")}).`,
    }),
    makeCreateTool(store, {
      name: "log_pretrip_inspection",
      description:
        "Record a completed pre-trip inspection: which truck or trailer, whether it passed, and any defects found. (This records that the inspection happened - the Fleet Checklists page holds the walkthrough itself.)",
      parameters: {
        type: "object",
        properties: {
          truck_id: { type: "string" },
          trailer_id: { type: "string" },
          driver_id: { type: "string" },
          passed: { type: "boolean" },
          defects_found: { type: "string" },
          inspected_at: { type: "string", description: "ISO timestamp. Defaults to now." },
        },
        required: ["passed"],
      },
      botSchema: z
        .object({
          truck_id: uuid.nullable().optional(),
          trailer_id: uuid.nullable().optional(),
          driver_id: uuid.nullable().optional(),
          inspected_at: z.string().min(1).optional(),
          passed: z.boolean(),
          defects_found: z.string().nullable().optional(),
        })
        .refine((d) => Boolean(d.truck_id) !== Boolean(d.trailer_id), {
          message: "exactly one of truck_id or trailer_id is required.",
          path: ["truck_id"],
        }),
      table: "pretrip_inspections",
      label: "pre-trip inspection",
      toRow: (args) => {
        const row = definedOnly(args);
        if (row.inspected_at === undefined) row.inspected_at = new Date().toISOString();
        return row;
      },
      rowSchema: createPretripInspectionSchema,
      summarize: (args) =>
        `Pre-trip inspection: ${args.passed ? "PASSED" : "FAILED"}${args.defects_found ? ` — defects: ${args.defects_found}` : ""}`,
      confirm: (args) => `Recorded the pre-trip inspection (${args.passed ? "passed" : "FAILED"}).`,
      // §5.5 (closes GAP-10's orphaned signal): a FAILED pre-trip's
      // defects don't just sit in a text column - each distinct
      // problem is staged as a tracked defect for his yes. A
      // passed inspection stages nothing, exactly as before (C3).
      afterCreate: async (args, inspectionId) => {
        if (args.passed !== false) return;
        const texts = splitDefectTexts(typeof args.defects_found === "string" ? args.defects_found : "");
        if (texts.length === 0) {
          return " It failed with no defect details written down - tell me what you found and I'll track each problem.";
        }
        const drafts = texts.map((description) => ({
          truckId: typeof args.truck_id === "string" ? args.truck_id : null,
          trailerId: typeof args.trailer_id === "string" ? args.trailer_id : null,
          description,
          source: "pretrip" as const,
          sourceInspectionId: inspectionId,
        }));
        const staged = await stageDefectProposals(store, drafts, "from the failed pre-trip you just logged");
        if (staged === 0) return;
        return ` I also staged ${staged} defect${staged === 1 ? "" : "s"} to track from that pre-trip (${texts.join("; ")}) - say yes to track ${staged === 1 ? "it" : "them"}, name the numbers to pick, or no to let ${staged === 1 ? "it" : "them"} go. Nothing is tracked until you say so.`;
      },
    }),
  );

}
