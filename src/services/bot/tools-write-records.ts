// The business-record write tools: credentials, load invoices, recurring obligations, broker follow-ups and drivers (GAP-11/12/13/14).
// Split out of tools-write.ts (decomposition pass, behavior unchanged): the same
// tools, pushed onto the same list in the same order.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { changedFields, dateString, idParam, makeCreateTool, makeUpdateTool, uuid, type Row } from "./tools-write-helpers";
import { definedOnly, dollars } from "./tool-helpers";
import { createCredentialSchema, updateCredentialSchema } from "@/data/schemas/credentials";
import { createLoadInvoiceSchema, updateLoadInvoiceSchema } from "@/data/schemas/load-invoices";
import { createRecurringObligationSchema, updateRecurringObligationSchema } from "@/data/schemas/recurring-obligations";
import { createBrokerFollowupSchema, updateBrokerFollowupSchema } from "@/data/schemas/broker-followups";
import { createDriverSchema, updateDriverSchema } from "@/data/schemas/drivers";

export function pushRecordTools(store: BotBrainStore, tools: AgentTool[]): void {
  // --- Cluster D (GAP-11/12/13/14): credentials, invoices,
  // obligations, follow-ups ---------------------------------------

  const credentialParams = {
    kind: {
      type: "string",
      enum: ["cdl", "medical_card", "annual_inspection", "registration_irp", "insurance", "other"],
    },
    label: { type: "string", description: "What the document is, in his words ('Florida CDL', 'DOT medical card')." },
    driver_id: { type: "string", description: "Driver id (uuid) when it's a driver's document." },
    truck_id: { type: "string", description: "Truck id (uuid) when it's a truck's document." },
    expires_on: { type: "string", description: "Expiry date, YYYY-MM-DD." },
    document_id: { type: "string", description: "The filed document photo's id, when there is one." },
    notes: { type: "string" },
  };
  tools.push(
    makeCreateTool(store, {
      name: "create_credential",
      description:
        "Register a credential/document with an expiry date (Credentials): CDL, DOT medical card, annual inspection, registration/IRP, insurance. Once registered, the expiry is watched at 60/30/7 days and lands in the day-wrap.",
      parameters: { type: "object", properties: credentialParams, required: ["kind", "label", "expires_on"] },
      botSchema: createCredentialSchema,
      table: "credentials",
      label: "credential",
      toRow: (args) => definedOnly(args),
      rowSchema: createCredentialSchema,
      summarize: (args) => `Credential: ${args.label} (expires ${args.expires_on})`,
      confirm: (args) => `Registered ${args.label}, expiring ${args.expires_on} — I'll watch it.`,
    }),
    makeUpdateTool(store, {
      name: "update_credential",
      description: "Update a credential — most often the new expiry date after a renewal.",
      parameters: {
        type: "object",
        properties: { credential_id: idParam("credential_id", "credential"), ...credentialParams },
        required: ["credential_id"],
      },
      botSchema: updateCredentialSchema.extend({ credential_id: uuid }),
      table: "credentials",
      label: "credential",
      idKey: "credential_id",
      toPatch: (args) => definedOnly(args),
      patchSchema: updateCredentialSchema,
      summarize: (args) => `Update the credential: ${changedFields(args, "credential_id")}`,
      confirm: (args) => `Updated the credential (${changedFields(args, "credential_id")}).`,
    }),
  );

  const invoiceBotFields = {
    load_id: uuid.optional(),
    broker_id: uuid.nullable().optional(),
    invoice_date: dateString.optional(),
    due_date: dateString.optional(),
    amount_dollars: z.number().nonnegative().optional(),
    paid_amount_dollars: z.number().nonnegative().optional(),
    paid_on: dateString.nullable().optional(),
    factored: z.boolean().optional(),
    factor_fee_dollars: z.number().nonnegative().nullable().optional(),
    factor_reserve_dollars: z.number().nonnegative().nullable().optional(),
    notes: z.string().optional(),
  };
  const createInvoiceBot = z.object({
    ...invoiceBotFields,
    load_id: uuid,
    invoice_date: dateString,
    due_date: dateString,
    amount_dollars: z.number().nonnegative(),
  });
  const updateInvoiceBot = z.object({ invoice_id: uuid, ...invoiceBotFields });
  const invoiceToRow = (args: Row): Row => {
    const { amount_dollars, paid_amount_dollars, factor_fee_dollars, factor_reserve_dollars, ...rest } =
      definedOnly(args);
    const row: Row = { ...rest };
    if (amount_dollars !== undefined) row.amount_cents = Math.round(Number(amount_dollars) * 100);
    if (paid_amount_dollars !== undefined) {
      row.paid_amount_cents = Math.round(Number(paid_amount_dollars) * 100);
    }
    if (factor_fee_dollars !== undefined && factor_fee_dollars !== null) {
      row.factor_fee_cents = Math.round(Number(factor_fee_dollars) * 100);
    }
    if (factor_reserve_dollars !== undefined && factor_reserve_dollars !== null) {
      row.factor_reserve_cents = Math.round(Number(factor_reserve_dollars) * 100);
    }
    return row;
  };
  const invoiceParams = {
    load_id: { type: "string", description: "Load id (uuid)." },
    broker_id: { type: "string", description: "Broker id (uuid)." },
    invoice_date: { type: "string", description: "YYYY-MM-DD" },
    due_date: { type: "string", description: "YYYY-MM-DD (invoice date + the broker's terms)." },
    amount_dollars: { type: "number", description: "Invoice amount in dollars (the load's rate)." },
    paid_amount_dollars: { type: "number", description: "Amount paid so far, in dollars." },
    paid_on: { type: "string", description: "Date fully paid, YYYY-MM-DD." },
    factored: { type: "boolean", description: "True when a factor bought this invoice." },
    factor_fee_dollars: { type: "number", description: "The factor's fee in dollars, when factored." },
    factor_reserve_dollars: { type: "number", description: "The factor's reserve holdback in dollars, when factored." },
    notes: { type: "string" },
  };
  tools.push(
    makeCreateTool(store, {
      name: "create_load_invoice",
      description:
        "Record an invoice for a completed load (Receivables): amount = the load's rate, due date = invoice date + the broker's payment terms. Starts the aging clock — 'completed' is not 'paid'.",
      parameters: {
        type: "object",
        properties: invoiceParams,
        required: ["load_id", "invoice_date", "due_date", "amount_dollars"],
      },
      botSchema: createInvoiceBot,
      table: "load_invoices",
      label: "invoice",
      toRow: invoiceToRow,
      rowSchema: createLoadInvoiceSchema,
      summarize: (args) => `Invoice: $${args.amount_dollars} due ${args.due_date}`,
      confirm: (args) => `Invoiced — $${args.amount_dollars} due ${args.due_date}. I'll age it from here.`,
    }),
    makeUpdateTool(store, {
      name: "update_load_invoice",
      description: "Update an invoice — record a payment (paid_amount_dollars, paid_on when fully paid) or correct terms.",
      parameters: {
        type: "object",
        properties: { invoice_id: idParam("invoice_id", "invoice"), ...invoiceParams },
        required: ["invoice_id"],
      },
      botSchema: updateInvoiceBot,
      table: "load_invoices",
      label: "invoice",
      idKey: "invoice_id",
      toPatch: invoiceToRow,
      patchSchema: updateLoadInvoiceSchema,
      summarize: (args) => `Update the invoice: ${changedFields(args, "invoice_id")}`,
      confirm: (args) => `Updated the invoice (${changedFields(args, "invoice_id")}).`,
    }),
  );

  const obligationBotFields = {
    name: z.string().min(1).optional(),
    amount_dollars: z.number().nonnegative().optional(),
    cadence: z.enum(["weekly", "biweekly", "monthly", "quarterly", "annual"]).optional(),
    day_of_month: z.number().int().min(1).max(31).nullable().optional(),
    weekday: z.number().int().min(0).max(6).nullable().optional(),
    anchor_date: dateString.nullable().optional(),
    active: z.boolean().optional(),
    notes: z.string().optional(),
  };
  const obligationToRow = (args: Row): Row => {
    const { amount_dollars, ...rest } = definedOnly(args);
    const row: Row = { ...rest };
    if (amount_dollars !== undefined) row.amount_cents = Math.round(Number(amount_dollars) * 100);
    return row;
  };
  const obligationParams = {
    name: { type: "string", description: "What the bill is ('Phone', 'Insurance', 'Truck payment')." },
    amount_dollars: { type: "number" },
    cadence: { type: "string", enum: ["weekly", "biweekly", "monthly", "quarterly", "annual"] },
    day_of_month: { type: "number", description: "For monthly cadences: the day it leaves (1-31)." },
    weekday: { type: "number", description: "For weekly cadences: 0 = Sunday .. 6 = Saturday." },
    anchor_date: { type: "string", description: "For biweekly: a known occurrence date, YYYY-MM-DD." },
    active: { type: "boolean" },
    notes: { type: "string" },
  };
  tools.push(
    makeCreateTool(store, {
      name: "create_recurring_obligation",
      description:
        "Register a recurring business obligation (Cash calendar): 'my phone bill is $95 on the 12th' becomes a dated, projected obligation so the tight week is visible before it arrives.",
      parameters: {
        type: "object",
        properties: obligationParams,
        required: ["name", "amount_dollars", "cadence"],
      },
      botSchema: z.object({
        ...obligationBotFields,
        name: z.string().min(1),
        amount_dollars: z.number().nonnegative(),
        cadence: z.enum(["weekly", "biweekly", "monthly", "quarterly", "annual"]),
      }),
      table: "recurring_obligations",
      label: "obligation",
      toRow: obligationToRow,
      rowSchema: createRecurringObligationSchema,
      summarize: (args) => `Obligation: ${args.name} $${args.amount_dollars} ${args.cadence}`,
      confirm: (args) => `Noted — ${args.name}, $${args.amount_dollars} ${args.cadence}. It's on the cash calendar.`,
    }),
    makeUpdateTool(store, {
      name: "update_recurring_obligation",
      description: "Update or deactivate a recurring obligation (amount changed, bill ended).",
      parameters: {
        type: "object",
        properties: { obligation_id: idParam("obligation_id", "obligation"), ...obligationParams },
        required: ["obligation_id"],
      },
      botSchema: z.object({ obligation_id: uuid, ...obligationBotFields }),
      table: "recurring_obligations",
      label: "obligation",
      idKey: "obligation_id",
      toPatch: obligationToRow,
      patchSchema: updateRecurringObligationSchema,
      summarize: (args) => `Update the obligation: ${changedFields(args, "obligation_id")}`,
      confirm: (args) => `Updated the obligation (${changedFields(args, "obligation_id")}).`,
    }),
  );

  const followupParams = {
    broker_id: { type: "string", description: "Broker id (uuid)." },
    note: { type: "string", description: "What's owed ('check call on the detention claim')." },
    due_on: { type: "string", description: "YYYY-MM-DD" },
    done_at: { type: "string", description: "ISO timestamp when done; null reopens it." },
  };
  tools.push(
    makeCreateTool(store, {
      name: "create_broker_followup",
      description:
        "Record a dated follow-up owed to a broker (a promised check call, paperwork to send). It surfaces in the day-wrap when it comes due.",
      parameters: { type: "object", properties: followupParams, required: ["broker_id", "note", "due_on"] },
      botSchema: createBrokerFollowupSchema,
      table: "broker_followups",
      label: "follow-up",
      toRow: (args) => definedOnly(args),
      rowSchema: createBrokerFollowupSchema,
      summarize: (args) => `Follow-up on ${args.due_on}: ${args.note}`,
      confirm: (args) => `Follow-up set for ${args.due_on} — I'll surface it in the day-wrap.`,
    }),
    makeUpdateTool(store, {
      name: "update_broker_followup",
      description: "Update a broker follow-up — set done_at when it's handled, or move the date.",
      parameters: {
        type: "object",
        properties: { followup_id: idParam("followup_id", "follow-up"), ...followupParams },
        required: ["followup_id"],
      },
      botSchema: updateBrokerFollowupSchema.extend({ followup_id: uuid }),
      table: "broker_followups",
      label: "follow-up",
      idKey: "followup_id",
      toPatch: (args) => definedOnly(args),
      patchSchema: updateBrokerFollowupSchema,
      summarize: (args) => `Update the follow-up: ${changedFields(args, "followup_id")}`,
      confirm: (args) => `Updated the follow-up (${changedFields(args, "followup_id")}).`,
    }),
  );

  const driverParams = {
    name: { type: "string" },
    cdl_number: { type: "string" },
    assigned_truck_id: { type: "string", description: "Truck id (uuid), or null to unassign." },
    assigned_trailer_id: { type: "string", description: "Trailer id (uuid) he normally pulls, or null to unassign." },
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
      summarize: (args) => `Update the driver: ${changedFields(args, "driver_id")}`,
      confirm: (args) => `Updated the driver (${changedFields(args, "driver_id")}).`,
    }),
  );

}
