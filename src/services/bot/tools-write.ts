// Agent omnipresence (docs/design/driver-mvp.md §9). The write
// tools that complete the bot's coverage: create + update for
// every app tab §8 didn't already cover (its expense / fuel /
// duty / memory / load-note tools live in tools.ts).
//
// Standing rule, unchanged from §8 and enforced by the agent
// loop: the owner's direct imperative executes immediately and
// confirms back; anything the bot proposes waits in
// bot_pending_actions for his yes. Arguments are validated twice:
// the bot-facing schema here (driver units - dollars, not cents),
// and the built database row against the SAME Zod schemas the
// UI/API use (src/data/schemas/*) before it is written.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import {
  definedOnly,
  dollars,
  fetchLiveRow,
  insertRow,
  isMissingColumnError,
  patchLiveRow,
  validateWith,
} from "./tool-helpers";
import { createBrokerSchema, updateBrokerSchema } from "@/data/schemas/brokers";
import { createCustomerSchema, updateCustomerSchema } from "@/data/schemas/customers";
import { createDriverSchema, updateDriverSchema } from "@/data/schemas/drivers";
import { relatedEntityTypeSchema } from "@/data/schemas/documents";
import { updateExpenseSchema } from "@/data/schemas/expenses";
import { updateFuelPurchaseSchema } from "@/data/schemas/fuel-purchases";
import { createLoadSchema, loadStatusSchema, updateLoadSchema } from "@/data/schemas/loads";
import {
  createMaintenanceEventSchema,
  updateMaintenanceEventSchema,
} from "@/data/schemas/maintenance-events";
import {
  createMaintenanceScheduleSchema,
  updateMaintenanceScheduleSchema,
} from "@/data/schemas/maintenance-schedules";
import {
  createEquipmentChecklistItemSchema,
  updateEquipmentChecklistItemSchema,
} from "@/data/schemas/equipment-checklist-items";
import { createPretripInspectionSchema } from "@/data/schemas/pretrip-inspections";
import { createTrailerSchema, updateTrailerSchema } from "@/data/schemas/trailers";
import { createTruckSchema, updateTruckSchema } from "@/data/schemas/trucks";

type Row = Record<string, unknown>;

const uuid = z.string().uuid();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

function changedFields(args: Record<string, unknown>, idKey: string): string {
  const fields = Object.keys(args).filter((k) => k !== idKey && args[k] !== undefined);
  return fields.length > 0 ? fields.join(", ") : "nothing";
}

/** Shared shape for a create tool: bot args -> row -> UI-schema check -> insert. */
function makeCreateTool(
  store: BotBrainStore,
  spec: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    botSchema: z.ZodType;
    table: string;
    label: string;
    toRow: (args: Row) => Row;
    rowSchema: z.ZodType;
    summarize: (args: Row) => string;
    confirm: (args: Row, id: string) => string;
  },
): AgentTool {
  const { client, companyId } = store;
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    access: "write",
    validateArgs: validateWith(spec.botSchema),
    summarize: (args) => spec.summarize(args as Row),
    async run(args) {
      const parsed = spec.botSchema.parse(args) as Row;
      const row = spec.rowSchema.parse(spec.toRow(parsed)) as Row;
      const id = await insertRow(client, spec.table, companyId, row);
      return `${spec.confirm(args as Row, id)} Record id ${id}.`;
    },
  };
}

/** Shared shape for an update tool: fetch -> merge -> UI-schema check -> patch only the named fields. */
function makeUpdateTool(
  store: BotBrainStore,
  spec: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    botSchema: z.ZodType;
    table: string;
    label: string;
    idKey: string;
    toPatch: (args: Row) => Row;
    patchSchema: z.ZodType;
    /** Full-row schema re-checked against the merged row when the entity has cross-field rules. */
    mergedSchema?: z.ZodType;
    summarize: (args: Row) => string;
    confirm: (args: Row) => string;
  },
): AgentTool {
  const { client, companyId } = store;
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    access: "write",
    validateArgs: validateWith(spec.botSchema),
    summarize: (args) => spec.summarize(args as Row),
    async run(args) {
      const parsed = spec.botSchema.parse(args) as Row;
      const id = String(parsed[spec.idKey]);
      const existing = await fetchLiveRow(client, spec.table, companyId, id, spec.label);
      const patch = spec.patchSchema.parse(spec.toPatch(parsed)) as Row;
      if (Object.keys(patch).length === 0) {
        throw new Error(`That ${spec.name} call named no fields to change.`);
      }
      if (spec.mergedSchema) {
        // Cross-field check on the would-be row. Stored nulls count
        // as absent: several UI schemas model a nullable column as
        // merely optional (e.g. loads.notes), so a legitimately
        // stored NULL must not fail the merged validation.
        const merged: Row = { ...existing, ...patch };
        for (const key of Object.keys(merged)) {
          if (merged[key] === null) delete merged[key];
        }
        spec.mergedSchema.parse(merged);
      }
      await patchLiveRow(client, spec.table, companyId, id, patch);
      return spec.confirm(args as Row);
    },
  };
}

const idParam = (key: string, entity: string) => ({
  type: "string",
  description: `The ${entity}'s id (uuid) - get it from the matching list tool first.`,
});

export function buildExtendedWriteTools(store: BotBrainStore): AgentTool[] {
  const tools: AgentTool[] = [];

  // --- Loads -----------------------------------------------------

  const loadBotFields = {
    truck_id: uuid.nullable().optional(),
    driver_id: uuid.nullable().optional(),
    broker_id: uuid.nullable().optional(),
    customer_id: uuid.nullable().optional(),
    origin: z.string().min(1).optional(),
    destination: z.string().min(1).optional(),
    pickup_date: dateString.optional(),
    delivery_date: dateString.optional(),
    rate_dollars: z.number().nonnegative().optional(),
    miles: z.number().int().nonnegative().optional(),
    status: loadStatusSchema.optional(),
    notes: z.string().optional(),
  };
  const createLoadBot = z
    .object({
      ...loadBotFields,
      origin: z.string().min(1, "origin is required."),
      destination: z.string().min(1, "destination is required."),
    })
    .refine(
      (d) => !d.pickup_date || !d.delivery_date || d.delivery_date >= d.pickup_date,
      { message: "delivery_date must not be before pickup_date.", path: ["delivery_date"] },
    );
  const updateLoadBot = z
    .object({ load_id: uuid, ...loadBotFields })
    .refine(
      (d) => !d.pickup_date || !d.delivery_date || d.delivery_date >= d.pickup_date,
      { message: "delivery_date must not be before pickup_date.", path: ["delivery_date"] },
    );
  const loadToRow = (args: Row): Row => {
    const { rate_dollars, ...rest } = definedOnly(args);
    const row: Row = { ...rest };
    if (rate_dollars !== undefined) row.rate_cents = Math.round(Number(rate_dollars) * 100);
    return row;
  };
  const loadParams = {
    origin: { type: "string" },
    destination: { type: "string" },
    pickup_date: { type: "string", description: "YYYY-MM-DD" },
    delivery_date: { type: "string", description: "YYYY-MM-DD" },
    rate_dollars: { type: "number", description: "The load's rate in dollars." },
    miles: { type: "number" },
    status: { type: "string", enum: ["draft", "confirmed", "completed"] },
    broker_id: { type: "string" },
    customer_id: { type: "string" },
    truck_id: { type: "string" },
    driver_id: { type: "string" },
    notes: { type: "string" },
  };

  tools.push(
    makeCreateTool(store, {
      name: "create_load",
      description:
        "Create a load in his books (Loads tab). Origin and destination are required; everything else can be filled in later. Leave fields he didn't mention out entirely - never guess a rate, date, or id.",
      parameters: { type: "object", properties: loadParams, required: ["origin", "destination"] },
      botSchema: createLoadBot,
      table: "loads",
      label: "load",
      toRow: (args) => loadToRow(args),
      rowSchema: createLoadSchema,
      summarize: (args) =>
        `Load: ${args.origin} → ${args.destination}` +
        `${args.pickup_date ? `, pickup ${args.pickup_date}` : ""}` +
        `${args.delivery_date ? `, delivery ${args.delivery_date}` : ""}` +
        `${typeof args.rate_dollars === "number" ? `, rate ${dollars(Math.round(args.rate_dollars * 100))}` : ""}`,
      confirm: (args) => `Created load ${args.origin} → ${args.destination}.`,
    }),
    makeUpdateTool(store, {
      name: "update_load",
      description:
        "Update a load - including its status (draft / confirmed / completed) when a run is booked or finished. Only the fields named are changed.",
      parameters: {
        type: "object",
        properties: { load_id: idParam("load_id", "load"), ...loadParams },
        required: ["load_id"],
      },
      botSchema: updateLoadBot,
      table: "loads",
      label: "load",
      idKey: "load_id",
      toPatch: (args) => loadToRow(args),
      patchSchema: updateLoadSchema,
      mergedSchema: createLoadSchema,
      summarize: (args) =>
        `Update load ${args.load_id}: ${changedFields(args, "load_id")}` +
        `${typeof args.status === "string" ? ` (status → ${args.status})` : ""}`,
      confirm: (args) => `Updated load ${args.load_id} (${changedFields(args, "load_id")}).`,
    }),
  );

  // --- Money updates ----------------------------------------------

  const updateExpenseBot = z.object({
    expense_id: uuid,
    category: z.enum(["insurance", "permits", "repairs", "other"]).optional(),
    amount_dollars: z.number().positive().optional(),
    expense_date: dateString.optional(),
    description: z.string().optional(),
    load_id: uuid.nullable().optional(),
    truck_id: uuid.nullable().optional(),
    driver_id: uuid.nullable().optional(),
  });
  tools.push(
    makeUpdateTool(store, {
      name: "update_expense",
      description: "Correct an expense already in his books (amount, category, date, description, or what it's linked to).",
      parameters: {
        type: "object",
        properties: {
          expense_id: idParam("expense_id", "expense"),
          category: { type: "string", enum: ["insurance", "permits", "repairs", "other"] },
          amount_dollars: { type: "number" },
          expense_date: { type: "string", description: "YYYY-MM-DD" },
          description: { type: "string" },
          load_id: { type: "string" },
          truck_id: { type: "string" },
        },
        required: ["expense_id"],
      },
      botSchema: updateExpenseBot,
      table: "expenses",
      label: "expense",
      idKey: "expense_id",
      toPatch: (args) => {
        const { expense_id: _id, amount_dollars, ...rest } = definedOnly(args);
        void _id;
        const patch: Row = { ...rest };
        if (amount_dollars !== undefined) patch.amount_cents = Math.round(Number(amount_dollars) * 100);
        return patch;
      },
      patchSchema: updateExpenseSchema,
      summarize: (args) => `Update expense ${args.expense_id}: ${changedFields(args, "expense_id")}`,
      confirm: (args) => `Updated expense ${args.expense_id} (${changedFields(args, "expense_id")}).`,
    }),
  );

  const updateFuelBot = z.object({
    fuel_purchase_id: uuid,
    total_dollars: z.number().positive().optional(),
    gallons: z.number().positive().optional(),
    location: z.string().min(1).optional(),
    purchased_at: z.string().min(1).optional(),
  });
  tools.push({
    name: "update_fuel_purchase",
    description: "Correct a fuel purchase already in his books (total, gallons, location, or time). Price per gallon is recomputed from total and gallons.",
    parameters: {
      type: "object",
      properties: {
        fuel_purchase_id: idParam("fuel_purchase_id", "fuel purchase"),
        total_dollars: { type: "number" },
        gallons: { type: "number" },
        location: { type: "string" },
        purchased_at: { type: "string", description: "ISO timestamp" },
      },
      required: ["fuel_purchase_id"],
    },
    access: "write",
    validateArgs: validateWith(updateFuelBot),
    summarize: (args) => `Update fuel purchase ${args.fuel_purchase_id}: ${changedFields(args as Row, "fuel_purchase_id")}`,
    async run(args) {
      const parsed = updateFuelBot.parse(args) as Row;
      const { client, companyId } = store;
      const existing = await fetchLiveRow(client, "fuel_purchases", companyId, String(parsed.fuel_purchase_id), "fuel purchase");
      const patch: Row = {};
      const totalCents =
        parsed.total_dollars !== undefined
          ? Math.round(Number(parsed.total_dollars) * 100)
          : (existing.total_cost_cents as number);
      const gallons = parsed.gallons !== undefined ? Number(parsed.gallons) : (existing.gallons as number);
      if (parsed.total_dollars !== undefined) patch.total_cost_cents = totalCents;
      if (parsed.gallons !== undefined) patch.gallons = gallons;
      if (parsed.total_dollars !== undefined || parsed.gallons !== undefined) {
        patch.price_per_gallon_cents = Math.round(totalCents / gallons);
      }
      if (parsed.location !== undefined) patch.location = parsed.location;
      if (parsed.purchased_at !== undefined) patch.purchased_at = parsed.purchased_at;
      updateFuelPurchaseSchema.parse(patch);
      await patchLiveRow(client, "fuel_purchases", companyId, String(parsed.fuel_purchase_id), patch);
      return `Updated fuel purchase ${parsed.fuel_purchase_id} (${changedFields(parsed, "fuel_purchase_id")}).`;
    },
  });

  // --- Contacts ----------------------------------------------------

  const contactParams = {
    name: { type: "string" },
    contact_email: { type: "string" },
    contact_phone: { type: "string" },
    notes: { type: "string" },
  };
  tools.push(
    makeCreateTool(store, {
      name: "create_broker",
      description: "Add a broker to his contacts (Brokers tab).",
      parameters: {
        type: "object",
        properties: { ...contactParams, mc_number: { type: "string" } },
        required: ["name"],
      },
      botSchema: createBrokerSchema,
      table: "brokers",
      label: "broker",
      toRow: (args) => definedOnly(args),
      rowSchema: createBrokerSchema,
      summarize: (args) => `Broker: ${args.name}${args.mc_number ? ` (MC ${args.mc_number})` : ""}`,
      confirm: (args) => `Added broker ${args.name}.`,
    }),
    makeUpdateTool(store, {
      name: "update_broker",
      description: "Update a broker's contact details or notes.",
      parameters: {
        type: "object",
        properties: { broker_id: idParam("broker_id", "broker"), ...contactParams, mc_number: { type: "string" } },
        required: ["broker_id"],
      },
      botSchema: updateBrokerSchema.extend({ broker_id: uuid }),
      table: "brokers",
      label: "broker",
      idKey: "broker_id",
      toPatch: (args) => definedOnly(args),
      patchSchema: updateBrokerSchema,
      summarize: (args) => `Update broker ${args.broker_id}: ${changedFields(args, "broker_id")}`,
      confirm: (args) => `Updated broker ${args.broker_id} (${changedFields(args, "broker_id")}).`,
    }),
    makeCreateTool(store, {
      name: "create_customer",
      description: "Add a customer to his contacts (Customers tab).",
      parameters: { type: "object", properties: contactParams, required: ["name"] },
      botSchema: createCustomerSchema,
      table: "customers",
      label: "customer",
      toRow: (args) => definedOnly(args),
      rowSchema: createCustomerSchema,
      summarize: (args) => `Customer: ${args.name}`,
      confirm: (args) => `Added customer ${args.name}.`,
    }),
    makeUpdateTool(store, {
      name: "update_customer",
      description: "Update a customer's contact details or notes.",
      parameters: {
        type: "object",
        properties: { customer_id: idParam("customer_id", "customer"), ...contactParams },
        required: ["customer_id"],
      },
      botSchema: updateCustomerSchema.extend({ customer_id: uuid }),
      table: "customers",
      label: "customer",
      idKey: "customer_id",
      toPatch: (args) => definedOnly(args),
      patchSchema: updateCustomerSchema,
      summarize: (args) => `Update customer ${args.customer_id}: ${changedFields(args, "customer_id")}`,
      confirm: (args) => `Updated customer ${args.customer_id} (${changedFields(args, "customer_id")}).`,
    }),
  );

  const driverParams = {
    name: { type: "string" },
    cdl_number: { type: "string" },
    assigned_truck_id: { type: "string", description: "Truck id (uuid), or null to unassign." },
    status: { type: "string", enum: ["active", "inactive"] },
  };
  tools.push(
    makeCreateTool(store, {
      name: "create_driver",
      description: "Add a driver to his records (Drivers tab).",
      parameters: { type: "object", properties: driverParams, required: ["name"] },
      botSchema: createDriverSchema,
      table: "drivers",
      label: "driver",
      toRow: (args) => definedOnly(args),
      rowSchema: createDriverSchema,
      summarize: (args) => `Driver: ${args.name}`,
      confirm: (args) => `Added driver ${args.name}.`,
    }),
    makeUpdateTool(store, {
      name: "update_driver",
      description: "Update a driver (name, CDL on file, assigned truck, status).",
      parameters: {
        type: "object",
        properties: { driver_id: idParam("driver_id", "driver"), ...driverParams },
        required: ["driver_id"],
      },
      botSchema: updateDriverSchema.extend({ driver_id: uuid }),
      table: "drivers",
      label: "driver",
      idKey: "driver_id",
      toPatch: (args) => definedOnly(args),
      patchSchema: updateDriverSchema,
      summarize: (args) => `Update driver ${args.driver_id}: ${changedFields(args, "driver_id")}`,
      confirm: (args) => `Updated driver ${args.driver_id} (${changedFields(args, "driver_id")}).`,
    }),
  );

  // --- Fleet --------------------------------------------------------

  const truckBaseParams = {
    unit_number: { type: "string" },
    vin: { type: "string" },
    make: { type: "string" },
    model: { type: "string" },
    year: { type: "number" },
    status: { type: "string", enum: ["active", "maintenance", "inactive"] },
    current_mileage: { type: "number" },
  };
  const truckProfileFields = {
    height_in: z.number().positive().optional(),
    length_in: z.number().positive().optional(),
    weight_lbs: z.number().positive().optional(),
    governed_speed_mph: z.number().positive().optional(),
    tank_capacity_gallons: z.number().positive().optional(),
    avg_mpg: z.number().positive().optional(),
    appliances: z.array(z.string().min(1)).optional(),
    appliance_notes: z.string().optional(),
  };
  const truckProfileParamProps = {
    height_in: { type: "number" },
    length_in: { type: "number" },
    weight_lbs: { type: "number" },
    governed_speed_mph: { type: "number" },
    tank_capacity_gallons: { type: "number" },
    avg_mpg: { type: "number" },
    appliances: {
      type: "array",
      items: { type: "string" },
      description: "Appliance inventory in the cab, e.g. [\"fridge\", \"microwave\"] - Smart Path's food routing keys off this.",
    },
    appliance_notes: { type: "string" },
  };
  const PROFILE_KEYS = Object.keys(truckProfileFields);

  tools.push(
    makeCreateTool(store, {
      name: "create_truck",
      description: "Add a truck to his fleet (Trucks tab).",
      parameters: { type: "object", properties: truckBaseParams, required: ["unit_number"] },
      botSchema: createTruckSchema,
      table: "trucks",
      label: "truck",
      toRow: (args) => definedOnly(args),
      rowSchema: createTruckSchema,
      summarize: (args) => `Truck: unit ${args.unit_number}`,
      confirm: (args) => `Added truck ${args.unit_number}.`,
    }),
    {
      name: "update_truck",
      description:
        "Update a truck - base details (unit number, status, mileage) and/or its Smart Path profile: dimensions, governed speed, tank, MPG, and the APPLIANCE INVENTORY (fridge, microwave, hot plate, inverter...). Profile fields live in the Smart Path part of the database; if that hasn't landed yet the tool says so instead of pretending to save them.",
      parameters: {
        type: "object",
        properties: {
          truck_id: idParam("truck_id", "truck"),
          ...truckBaseParams,
          ...truckProfileParamProps,
        },
        required: ["truck_id"],
      },
      access: "write",
      validateArgs: validateWith(
        updateTruckSchema.extend({ truck_id: uuid }).extend(truckProfileFields),
      ),
      summarize: (args) =>
        `Update truck ${args.truck_id}: ${changedFields(args as Row, "truck_id")}` +
        `${Array.isArray((args as Row).appliances) ? ` — appliances: ${((args as Row).appliances as string[]).join(", ")}` : ""}`,
      async run(args) {
        const schema = updateTruckSchema.extend({ truck_id: uuid }).extend(truckProfileFields);
        const parsed = schema.parse(args) as Row;
        const { client, companyId } = store;
        const id = String(parsed.truck_id);
        await fetchLiveRow(client, "trucks", companyId, id, "truck");
        const all = definedOnly(parsed);
        delete all.truck_id;
        const profilePatch: Row = {};
        const basePatch: Row = {};
        for (const [key, value] of Object.entries(all)) {
          if (PROFILE_KEYS.includes(key)) profilePatch[key] = value;
          else basePatch[key] = value;
        }
        if (Object.keys(profilePatch).length > 0) {
          // Profile first: if the columns aren't in the database yet
          // (Smart Path migration 00017), fail BEFORE touching the
          // base row and say exactly that - no silent partial save.
          const { error } = await client
            .from("trucks")
            .update(profilePatch)
            .eq("id", id)
            .eq("company_id", companyId)
            .is("deleted_at", null);
          if (error) {
            if (isMissingColumnError(error)) {
              throw new Error(
                "The truck profile fields (size/speed/appliances) aren't in the database yet - they arrive with the Smart Path update. Nothing was changed.",
              );
            }
            throw new Error(error.message);
          }
        }
        if (Object.keys(basePatch).length > 0) {
          updateTruckSchema.parse(basePatch);
          await patchLiveRow(client, "trucks", companyId, id, basePatch);
        }
        return `Updated truck ${id} (${changedFields(parsed, "truck_id")}).`;
      },
    },
    makeCreateTool(store, {
      name: "create_trailer",
      description: "Add a trailer to his fleet (Trailers tab).",
      parameters: {
        type: "object",
        properties: {
          unit_number: { type: "string" },
          vin: { type: "string" },
          trailer_type: { type: "string" },
          status: { type: "string", enum: ["active", "maintenance", "inactive"] },
        },
        required: ["unit_number"],
      },
      botSchema: createTrailerSchema,
      table: "trailers",
      label: "trailer",
      toRow: (args) => definedOnly(args),
      rowSchema: createTrailerSchema,
      summarize: (args) => `Trailer: unit ${args.unit_number}`,
      confirm: (args) => `Added trailer ${args.unit_number}.`,
    }),
    makeUpdateTool(store, {
      name: "update_trailer",
      description: "Update a trailer (unit number, type, status).",
      parameters: {
        type: "object",
        properties: {
          trailer_id: idParam("trailer_id", "trailer"),
          unit_number: { type: "string" },
          vin: { type: "string" },
          trailer_type: { type: "string" },
          status: { type: "string", enum: ["active", "maintenance", "inactive"] },
        },
        required: ["trailer_id"],
      },
      botSchema: updateTrailerSchema.extend({ trailer_id: uuid }),
      table: "trailers",
      label: "trailer",
      idKey: "trailer_id",
      toPatch: (args) => definedOnly(args),
      patchSchema: updateTrailerSchema,
      summarize: (args) => `Update trailer ${args.trailer_id}: ${changedFields(args, "trailer_id")}`,
      confirm: (args) => `Updated trailer ${args.trailer_id} (${changedFields(args, "trailer_id")}).`,
    }),
  );

  // --- Maintenance ---------------------------------------------------

  tools.push(
    makeCreateTool(store, {
      name: "create_maintenance_event",
      description: "Record maintenance/repair work that was done on a truck (Maintenance tab): what, when, what it cost.",
      parameters: {
        type: "object",
        properties: {
          truck_id: idParam("truck_id", "truck"),
          description: { type: "string" },
          cost_dollars: { type: "number" },
          service_date: { type: "string", description: "YYYY-MM-DD" },
          mileage_at_service: { type: "number" },
        },
        required: ["truck_id", "description", "service_date"],
      },
      botSchema: z.object({
        truck_id: uuid,
        description: z.string().min(1),
        cost_dollars: z.number().nonnegative().nullable().optional(),
        service_date: dateString,
        mileage_at_service: z.number().int().nonnegative().nullable().optional(),
      }),
      table: "maintenance_events",
      label: "maintenance event",
      toRow: (args) => {
        const { cost_dollars, ...rest } = definedOnly(args);
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
        "Set up a preventative-maintenance schedule (e.g. oil change every 10,000 miles, pigtail inspection every 30 days) for exactly one truck or trailer, with at least one interval.",
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
    }),
  );

  // --- Documents -------------------------------------------------------

  tools.push({
    name: "attach_document",
    description:
      "Attach (or re-attach) a document already in his files to a load, truck, trailer, or driver - e.g. a BOL photo to its load. The file itself is uploaded in the app (More → Documents); this points it at the right record. Get ids from list_documents/search_documents and list_loads.",
    parameters: {
      type: "object",
      properties: {
        document_id: idParam("document_id", "document"),
        related_entity_type: { type: "string", enum: ["truck", "trailer", "driver", "load"] },
        related_entity_id: { type: "string", description: "The id of the record to attach it to." },
      },
      required: ["document_id", "related_entity_type", "related_entity_id"],
    },
    access: "write",
    validateArgs: validateWith(
      z.object({
        document_id: uuid,
        related_entity_type: relatedEntityTypeSchema,
        related_entity_id: uuid,
      }),
    ),
    summarize: (args) => `Attach document ${args.document_id} to ${args.related_entity_type} ${args.related_entity_id}`,
    async run(args) {
      const parsed = z
        .object({ document_id: uuid, related_entity_type: relatedEntityTypeSchema, related_entity_id: uuid })
        .parse(args);
      const { client, companyId } = store;
      // documents has no deleted_at (hard-delete table, docs/schemas.md) -
      // never filter on it.
      const { data, error } = await client
        .from("documents")
        .select("id, file_name")
        .eq("id", parsed.document_id)
        .eq("company_id", companyId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error(`No document with id ${parsed.document_id} in his records.`);
      const { error: updateError } = await client
        .from("documents")
        .update({ related_entity_type: parsed.related_entity_type, related_entity_id: parsed.related_entity_id })
        .eq("id", parsed.document_id)
        .eq("company_id", companyId);
      if (updateError) throw new Error(updateError.message);
      return `Attached "${(data as { file_name: string }).file_name}" to ${parsed.related_entity_type} ${parsed.related_entity_id}.`;
    },
  });

  // --- Deletes (always proposed - the loop's alwaysPropose flag) -------

  const DELETE_TARGETS = {
    load: { table: "loads", label: (r: Row) => `load ${r.origin} → ${r.destination}` },
    expense: { table: "expenses", label: (r: Row) => `expense ${dollars(Number(r.amount_cents ?? 0))} (${r.category}, ${r.expense_date})` },
    fuel_purchase: { table: "fuel_purchases", label: (r: Row) => `fuel purchase ${dollars(Number(r.total_cost_cents ?? 0))} on ${String(r.purchased_at).slice(0, 10)}` },
    broker: { table: "brokers", label: (r: Row) => `broker ${r.name}` },
    customer: { table: "customers", label: (r: Row) => `customer ${r.name}` },
    driver: { table: "drivers", label: (r: Row) => `driver ${r.name}` },
    truck: { table: "trucks", label: (r: Row) => `truck ${r.unit_number}` },
    trailer: { table: "trailers", label: (r: Row) => `trailer ${r.unit_number}` },
    maintenance_event: { table: "maintenance_events", label: (r: Row) => `maintenance event "${r.description}"` },
    maintenance_schedule: { table: "maintenance_schedules", label: (r: Row) => `maintenance schedule "${r.description}"` },
    checklist_item: { table: "equipment_checklist_items", label: (r: Row) => `checklist item "${r.item_name}"` },
    pretrip_inspection: { table: "pretrip_inspections", label: (r: Row) => `pre-trip inspection from ${String(r.inspected_at).slice(0, 10)}` },
    duty_log: { table: "duty_logs", label: (r: Row) => `duty log entry (${r.duty_status} from ${r.started_at})` },
  } as const;
  type DeleteEntity = keyof typeof DELETE_TARGETS;
  const deleteBot = z.object({
    entity: z.enum(Object.keys(DELETE_TARGETS) as [DeleteEntity, ...DeleteEntity[]]),
    record_id: uuid,
  });

  tools.push({
    name: "delete_record",
    description:
      "Delete a record (soft delete - it leaves his lists but stays recoverable in the database). DELETES ALWAYS WAIT FOR HIS YES: even when he orders one directly, this stages a proposal and only his yes on the proposal deletes. Use the matching list tool first so he can see exactly which record is meant.",
    parameters: {
      type: "object",
      properties: {
        entity: { type: "string", enum: Object.keys(DELETE_TARGETS) },
        record_id: idParam("record_id", "record"),
      },
      required: ["entity", "record_id"],
    },
    access: "write",
    alwaysPropose: true,
    validateArgs: validateWith(deleteBot),
    summarize: (args) => `DELETE ${args.entity} record ${args.record_id}`,
    async run(args) {
      const parsed = deleteBot.parse(args);
      const target = DELETE_TARGETS[parsed.entity];
      const { client, companyId } = store;
      const row = await fetchLiveRow(client, target.table, companyId, parsed.record_id, parsed.entity);
      await patchLiveRow(client, target.table, companyId, parsed.record_id, {
        deleted_at: new Date().toISOString(),
      });
      return `Deleted ${target.label(row)}.`;
    },
  });

  return tools;
}
