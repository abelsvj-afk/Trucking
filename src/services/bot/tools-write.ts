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

import { pushFleetTools } from "./tools-write-fleet";
import { pushRecordTools } from "./tools-write-records";
import { pushMaintenanceTools } from "./tools-write-maintenance";
import { changedFields, dateString, idParam, makeCreateTool, makeUpdateTool, uuid, type Row } from "./tools-write-helpers";
import { fuelFieldsFromReceipt } from "./fuel-receipt";
import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { definedOnly, dollars, fetchLiveRow, insertRow, patchLiveRow, validateWith } from "./tool-helpers";
import { createBrokerSchema, updateBrokerSchema } from "@/data/schemas/brokers";
import { createCustomerSchema, updateCustomerSchema } from "@/data/schemas/customers";
import { createFacilitySchema, updateFacilitySchema } from "@/data/schemas/facilities";
import { relatedEntityTypeSchema } from "@/data/schemas/documents";
import { updateExpenseSchema } from "@/data/schemas/expenses";
import { updateFuelPurchaseSchema } from "@/data/schemas/fuel-purchases";
import { createLoadSchema, loadStatusSchema, updateLoadSchema } from "@/data/schemas/loads";
import { researchNowSchema } from "@/data/schemas/research";
import { PRETRIP_PHOTO_DEFAULT_ITEMS, dismissResearchRequest, requestPretripPhotos } from "@/services/research/requests";

export function buildExtendedWriteTools(store: BotBrainStore): AgentTool[] {
  const tools: AgentTool[] = [];

  // --- Loads -----------------------------------------------------

  const loadBotFields = {
    truck_id: uuid.nullable().optional(),
    trailer_id: uuid.nullable().optional(),
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
    // GAP-02/04/05/03/15 (migrations 00052/00053): what the rate con
    // already carries — windows, detention terms, weight, lane
    // states, facility links.
    pickup_window_start: z.string().optional(),
    pickup_window_end: z.string().optional(),
    delivery_window_start: z.string().optional(),
    delivery_window_end: z.string().optional(),
    detention_free_minutes: z.number().int().nonnegative().optional(),
    detention_rate_dollars: z.number().nonnegative().optional(),
    weight_lbs: z.number().int().positive().optional(),
    origin_state: z.string().length(2).optional(),
    destination_state: z.string().length(2).optional(),
    pickup_facility_id: uuid.nullable().optional(),
    delivery_facility_id: uuid.nullable().optional(),
    // Trip intake (migration 00061)
    trip_number: z.string().min(1).optional(),
    broker_reference: z.string().min(1).optional(),
    deadhead_miles: z.number().nonnegative().optional(),
    loaded_miles: z.number().nonnegative().optional(),
    pickup_tz: z.string().min(1).optional(),
    delivery_tz: z.string().min(1).optional(),
  };
  const createLoadBot = z
    .object({
      ...loadBotFields,
      origin: z.string().min(1, "origin is required."),
      destination: z.string().min(1, "destination is required."),
      // The dispatcher's requirements, saved with the load in the same yes.
      tasks: z.array(z.string().trim().min(1)).max(30).optional(),
      // Every stop of the trip, with its appointment in the zone it was written in.
      stops: z
        .array(
          z.object({
            seq: z.number().int().min(1),
            kind: z.enum(["pickup", "delivery", "other"]),
            name: z.string().optional(),
            address: z.string().optional(),
            appointment_at: z.string().optional(),
            appointment_tz: z.string().optional(),
          }),
        )
        .max(40)
        .optional(),
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
    const { rate_dollars, detention_rate_dollars, tasks: _tasks, stops: _stops, ...rest } = definedOnly(args);
    void _tasks;
    void _stops;
    const row: Row = { ...rest };
    if (rate_dollars !== undefined) row.rate_cents = Math.round(Number(rate_dollars) * 100);
    if (detention_rate_dollars !== undefined) {
      row.detention_rate_cents_per_hour = Math.round(Number(detention_rate_dollars) * 100);
    }
    return row;
  };
  const loadParams = {
    origin: { type: "string" },
    destination: { type: "string" },
    pickup_date: { type: "string", description: "YYYY-MM-DD" },
    delivery_date: { type: "string", description: "YYYY-MM-DD" },
    rate_dollars: { type: "number", description: "The load's rate in dollars." },
    miles: { type: "number" },
    pickup_window_start: { type: "string", description: "Appointment window start (ISO timestamp) from the rate con." },
    pickup_window_end: { type: "string", description: "Appointment window end (ISO timestamp)." },
    delivery_window_start: { type: "string", description: "Delivery window start (ISO timestamp)." },
    delivery_window_end: { type: "string", description: "Delivery window end (ISO timestamp)." },
    detention_free_minutes: { type: "number", description: "Free minutes before detention bills, per the rate con." },
    detention_rate_dollars: { type: "number", description: "Detention rate per hour in dollars, per the rate con." },
    weight_lbs: { type: "number", description: "Load weight in pounds (from the scale ticket / rate con)." },
    origin_state: { type: "string", description: "Two-letter origin state." },
    destination_state: { type: "string", description: "Two-letter destination state." },
    status: { type: "string", enum: ["draft", "confirmed", "completed"] },
    broker_id: { type: "string" },
    customer_id: { type: "string" },
    truck_id: { type: "string" },
    trailer_id: { type: "string", description: "Trailer id (uuid) on this trip - from list_trailers." },
    driver_id: { type: "string" },
    notes: { type: "string" },
    trip_number: { type: "string", description: "The dispatcher's trip/assignment number (e.g. 1234). NOT the broker's name and NOT the reference." },
    broker_reference: { type: "string", description: "The broker's reference/PRO number for this load (e.g. REF123456)." },
    deadhead_miles: { type: "number", description: "Empty miles to the pickup, exact (e.g. 120.00)." },
    loaded_miles: { type: "number", description: "Loaded miles pickup to delivery, exact (e.g. 900.5). Set miles to the rounded total." },
    pickup_tz: { type: "string", description: "IANA zone of the pickup appointment as written (e.g. America/Chicago for CST at Springfield MO)." },
    delivery_tz: { type: "string", description: "IANA zone of the delivery appointment as written (e.g. America/New_York)." },
  };

  tools.push(
    makeCreateTool(store, {
      name: "create_load",
      description:
        "Create a load in his books (Loads tab). Origin and destination are required; everything else can be filled in later. Leave fields he didn't mention out entirely - never guess a rate, date, or id.",
      parameters: {
        type: "object",
        properties: {
          ...loadParams,
          stops: {
            type: "array",
            description: "Every stop of the trip in order (any number). appointment_at is an ISO instant; appointment_tz the IANA zone it was written in.",
            items: {
              type: "object",
              properties: {
                seq: { type: "number" },
                kind: { type: "string", enum: ["pickup", "delivery", "other"] },
                name: { type: "string" },
                address: { type: "string" },
                appointment_at: { type: "string" },
                appointment_tz: { type: "string" },
              },
              required: ["seq", "kind"],
            },
          },
          tasks: { type: "array", items: { type: "string" }, description: "Dispatcher requirements for this trip, one per item (photos, seal, signed BOL, status at every stop, wait for approval before leaving). Only what the message states." },
        },
        required: ["origin", "destination"],
      },
      botSchema: createLoadBot,
      newerColumns: ["trailer_id", "trip_number", "broker_reference", "deadhead_miles", "loaded_miles", "pickup_tz", "delivery_tz"],
      afterCreate: async (args, id) => {
        const tasks = Array.isArray(args.tasks) ? (args.tasks as string[]) : [];
        const stops = Array.isArray(args.stops) ? (args.stops as Row[]) : [];
        const notes: string[] = [];
        if (stops.length > 0) {
          const { error } = await store.client.from("load_stops").insert(
            stops.map((st) => ({
              company_id: store.companyId, load_id: id, seq: st.seq, kind: st.kind,
              name: st.name ?? null, address: st.address ?? null,
              appointment_at: st.appointment_at ?? null, appointment_tz: st.appointment_tz ?? null,
            })),
          );
          notes.push(error ? ` The load is saved but its stops were not (${error.message}) - say so and offer to retry.` : ` Saved ${stops.length} stop${stops.length === 1 ? "" : "s"}.`);
        }
        if (tasks.length > 0) {
          const { error } = await store.client.from("load_tasks").insert(
            tasks.map((text, i) => ({ company_id: store.companyId, load_id: id, text, sort_order: i })),
          );
          notes.push(error ? ` The load is saved but its task list was not (${error.message}) - say so and offer to retry.` : ` Saved ${tasks.length} trip task${tasks.length === 1 ? "" : "s"}.`);
        }
        return notes.join("") || undefined;
      },
      table: "loads",
      label: "load",
      toRow: (args) => loadToRow(args),
      rowSchema: createLoadSchema,
      summarize: (args) =>
        `Load${args.trip_number ? ` (trip ${args.trip_number})` : ""}: ${args.origin} → ${args.destination}` +
        `${args.broker_reference ? `, ref ${args.broker_reference}` : ""}` +
        `${args.pickup_window_start ? `, pickup appt ${args.pickup_window_start}${args.pickup_tz ? ` (${args.pickup_tz})` : ""}` : ""}` +
        `${args.delivery_window_start ? `, delivery appt ${args.delivery_window_start}${args.delivery_tz ? ` (${args.delivery_tz})` : ""}` : ""}` +
        `${typeof args.deadhead_miles === "number" || typeof args.loaded_miles === "number" ? `, miles: deadhead ${args.deadhead_miles ?? "?"} + loaded ${args.loaded_miles ?? "?"}${typeof args.miles === "number" ? ` = ${args.miles} total` : ""}` : ""}` +
        `${Array.isArray(args.stops) && args.stops.length > 2 ? `, ${args.stops.length} stops` : ""}` +
        `${Array.isArray(args.tasks) && args.tasks.length > 0 ? `, ${args.tasks.length} trip task(s)` : ""}` +
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
    // GAP-15: purchase state (IFTA).
    state: z.string().length(2).optional(),
    purchased_at: z.string().min(1).optional(),
    // Unit D (00068): assigning fuel to a load is the owner's act - this tool only does it when he says so.
    load_id: uuid.nullable().optional(),
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
        state: { type: "string", description: "Two-letter purchase state (IFTA)." },
        purchased_at: { type: "string", description: "ISO timestamp" },
        load_id: { type: "string", description: "Assign this fuel to one load (uuid from list_loads), ONLY when he says it was for that load; null un-assigns. Never guess it from the date or truck." },
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
      if (parsed.total_dollars !== undefined || parsed.gallons !== undefined) {
        // Unit C: re-derive price + reasoned rounding adjustment so the
        // row keeps the receipt total AND the 00043 invariant.
        const totalCents =
          parsed.total_dollars !== undefined
            ? Math.round(Number(parsed.total_dollars) * 100)
            : Number(existing.total_cost_cents);
        const gallons = parsed.gallons !== undefined ? Number(parsed.gallons) : Number(existing.gallons);
        Object.assign(patch, fuelFieldsFromReceipt(gallons, totalCents));
      }
      if (parsed.location !== undefined) patch.location = parsed.location;
      if (parsed.state !== undefined) patch.state = String(parsed.state).toUpperCase();
      if (parsed.purchased_at !== undefined) patch.purchased_at = parsed.purchased_at;
      if (parsed.load_id !== undefined) patch.load_id = parsed.load_id;
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

  // --- Facilities (GAP-03: place memory) ---------------------------

  const facilityParams = {
    name: { type: "string" },
    address: { type: "string" },
    city: { type: "string" },
    state: { type: "string", description: "Two-letter state." },
    kind: { type: "string", enum: ["shipper", "receiver", "both"] },
    checkin_notes: { type: "string", description: "How check-in works there (guard shack, BOL number, appointment desk)." },
    dock_notes: { type: "string", description: "Dock/yard realities (door assignment, lumpers, wait pattern)." },
    parking_notes: { type: "string", description: "Overnight parking reality at or near the facility." },
    detention_notes: { type: "string", description: "How detention actually goes there (when it started, whether it paid)." },
    hours_notes: { type: "string", description: "Receiving/shipping hours." },
    contact_name: { type: "string" },
    contact_phone: { type: "string" },
  };
  tools.push(
    makeCreateTool(store, {
      name: "create_facility",
      description:
        "Remember a facility/place he picks up or delivers at (Facilities): name, city/state, and what he learns about it — check-in, docks, parking, detention, hours. Created from rate cons and his after-action words; enriched over visits.",
      parameters: { type: "object", properties: facilityParams, required: ["name"] },
      botSchema: createFacilitySchema,
      table: "facilities",
      label: "facility",
      toRow: (args) => definedOnly(args),
      rowSchema: createFacilitySchema,
      summarize: (args) => `Facility: ${args.name}${args.city ? ` (${args.city}${args.state ? `, ${args.state}` : ""})` : ""}`,
      confirm: (args) => `Remembered the facility ${args.name}.`,
    }),
    makeUpdateTool(store, {
      name: "update_facility",
      description:
        "Update a facility's remembered facts — after a visit, what he learned (check-in, parking, detention behavior) belongs here so the next visit starts smarter.",
      parameters: {
        type: "object",
        properties: { facility_id: idParam("facility_id", "facility"), ...facilityParams },
        required: ["facility_id"],
      },
      botSchema: updateFacilitySchema.extend({ facility_id: uuid }),
      table: "facilities",
      label: "facility",
      idKey: "facility_id",
      toPatch: (args) => definedOnly(args),
      patchSchema: updateFacilitySchema,
      summarize: (args) => `Update facility ${args.facility_id}: ${changedFields(args, "facility_id")}`,
      confirm: (args) => `Updated facility ${args.facility_id} (${changedFields(args, "facility_id")}).`,
    }),
  );

  pushRecordTools(store, tools);

  pushFleetTools(store, tools);

  pushMaintenanceTools(store, tools);

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
    memory: { table: "bot_memories", label: (r: Row) => `memory "${String(r.content ?? "").slice(0, 120)}"` },
    duty_log: { table: "duty_logs", label: (r: Row) => `duty log entry (${r.duty_status} from ${r.started_at})` },
  } as const;
  type DeleteEntity = keyof typeof DELETE_TARGETS;
  const deleteBot = z.object({
    entity: z.enum(Object.keys(DELETE_TARGETS) as [DeleteEntity, ...DeleteEntity[]]),
    record_id: uuid,
  });

  // R-6 (Research Intelligence design D-7/D-5): the conversational
  // side of the Deep Research engine. queue_research writes EXACTLY
  // the manual row the app's research-now route writes (migration
  // 00019 fences owner-session inserts to that shape); the engine's
  // tick executes it under the same caps and kill switch as every
  // other run - this tool never calls the AI provider itself.
  const queueResearchBot = z.object({
    topic: z.string().trim().min(3).max(200),
  });
  tools.push({
    name: "queue_research",
    description:
      "Queue a Deep Research run on a topic he names (e.g. diesel prices in the Southeast, a new state weight law). The research engine picks it up on its next tick under its normal caps - it does NOT run instantly. The finished briefing lands in list_research_briefings and the app's Research page. Use when he asks you to look into something the watchers don't already cover.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The research topic, in his words (3-200 characters)." },
      },
      required: ["topic"],
    },
    access: "write",
    validateArgs: validateWith(queueResearchBot),
    summarize: (args) => `Queue Deep Research on "${String(args.topic ?? "")}"`,
    async run(args) {
      const parsed = queueResearchBot.parse(args);
      // Same topic bounds the app route enforces (researchNowSchema).
      researchNowSchema.parse({ topic: parsed.topic });
      const { client, companyId } = store;
      const id = await insertRow(client, "research_runs", companyId, {
        trigger_kind: "manual",
        topic: parsed.topic,
        trigger_detail: { reason: "Owner requested this research in conversation with Abel." },
        status: "queued",
      });
      return (
        `Queued a Deep Research run on "${parsed.topic}" (run id ${id}). ` +
        "The engine runs it on its next tick under its normal caps - when the briefing is ready it shows in list_research_briefings and the app's Research page, and the engine's delivery rules decide whether it also buzzes his phone."
      );
    },
  });

  const requestPhotosBot = z.object({
    load_id: uuid.optional(),
    checklist_kind: z.string().trim().min(1).max(60).optional(),
    items: z.array(z.string().trim().min(1).max(60)).min(1).max(10).optional(),
    reason: z.string().trim().min(1).max(300).optional(),
  });
  tools.push({
    name: "request_pretrip_photos",
    description:
      "Record a pre-trip photo ask (a pending research_requests row): ask him to photograph specific things - by default tires, lights, load securement, and the BOL. Use when he wants to be asked for photos before a load rolls, or when a pre-trip is coming up and the photos should be captured. The ask stays pending until Abel files MATCHING pre-trip photos through photo intake (same load, covering every item asked for — that pipeline marks it fulfilled) or he says skip it (dismiss_research_request).",
    parameters: {
      type: "object",
      properties: {
        load_id: { type: "string", description: "Optional load id (from list_loads) the photos are for." },
        checklist_kind: { type: "string", description: "Checklist context label, e.g. \"pre-trip\". Default \"pre-trip\"." },
        items: {
          type: "array",
          items: { type: "string" },
          description: "What to photograph. Default: tires, lights, load securement, BOL.",
        },
        reason: { type: "string", description: "Why the photos are wanted - you repeat this when you ask him." },
      },
    },
    access: "write",
    validateArgs: validateWith(requestPhotosBot),
    summarize: (args) => {
      const items = Array.isArray(args.items) && args.items.length > 0 ? args.items : PRETRIP_PHOTO_DEFAULT_ITEMS;
      return `Ask him for pre-trip photos (${items.join(", ")})${args.load_id ? ` for load ${String(args.load_id)}` : ""}`;
    },
    async run(args) {
      const parsed = requestPhotosBot.parse(args);
      const { client, companyId } = store;
      const id = await requestPretripPhotos(client, companyId, {
        loadId: parsed.load_id ?? null,
        checklistKind: parsed.checklist_kind,
        items: parsed.items,
        reason: parsed.reason,
      });
      const items = parsed.items ?? [...PRETRIP_PHOTO_DEFAULT_ITEMS];
      return (
        `Recorded the pre-trip photo ask (request id ${id}): photograph ${items.join(", ")}` +
        `${parsed.load_id ? ` for load ${parsed.load_id}` : ""}. ` +
        "It stays pending until his photos are filed; ask him for them when the pre-trip moment comes."
      );
    },
  });

  const dismissRequestBot = z.object({ request_id: uuid });
  tools.push({
    name: "dismiss_research_request",
    description:
      "Dismiss a pending pre-trip photo ask (from list_research_requests) when he says skip it or it's no longer needed. Only dismisses asks still waiting - a fulfilled ask is history and stays.",
    parameters: {
      type: "object",
      properties: { request_id: { type: "string", description: "The research request id from list_research_requests." } },
      required: ["request_id"],
    },
    access: "write",
    validateArgs: validateWith(dismissRequestBot),
    summarize: (args) => `Dismiss pre-trip photo ask ${String(args.request_id ?? "")}`,
    async run(args) {
      const parsed = dismissRequestBot.parse(args);
      const { client, companyId } = store;
      const dismissed = await dismissResearchRequest(client, companyId, parsed.request_id);
      return dismissed
        ? `Dismissed photo ask ${parsed.request_id} - it won't be raised again.`
        : `Photo ask ${parsed.request_id} wasn't pending (already fulfilled, dismissed, or not his) - nothing changed.`;
    },
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
