// Abel Intelligence Upgrade, Phase D (design §5). The pay-truth
// tools: the pin, settlement recording, and the code-computed
// reports. Kept in their own module like route-check-tool.ts -
// these wrap the pay domain (pay-pin.ts / pay-truth.ts / the
// settlements store), not a single table.
//
// Discipline, same as the pay advisor: the MODEL assembles inputs
// from his words and his documents; CODE does every figure. Money
// crosses the tool boundary in dollars (the house convention) and
// is stored in cents.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import {
  extractSettlementStructure,
  formatSettlementExtraction,
} from "@/services/ai/settlement-extraction";
import type { BotBrainStore } from "./store";
import { validateWith } from "./tool-helpers";
import { loadHosCost } from "@/lib/hos-cost";
import { loadHosWindow } from "@/services/api/hos-window";
import { glanceFromSnapshot } from "@/services/api/pay-summary";
import {
  formatPayPin,
  isPinned,
  type PayPin,
} from "./pay-pin";
import {
  buildWeeklyPayReport,
  candidateModels,
  explainLoadEconomics,
  type SettlementFigures,
} from "./pay-truth";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function cents(dollarsValue: number): number {
  return Math.round(dollarsValue * 100);
}

const settlementLineArgs = z.object({
  kind: z.enum([
    "load_pay", "carrier_cut", "fuel", "tolls", "advance", "factoring",
    "detention", "layover", "escrow", "insurance", "dispatch_fee",
    "other_earning", "other_deduction",
  ]),
  label: z.string().min(1),
  /** Signed dollars: earnings positive, deductions negative. */
  amount_dollars: z.number(),
  load_id: z.string().uuid().optional(),
});

const recordSettlementArgs = z.object({
  issuer_name: z.string().min(1),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gross_dollars: z.number().nonnegative(),
  carrier_cut_dollars: z.number().nonnegative().optional(),
  net_to_truck_dollars: z.number().nonnegative().optional(),
  driver_pay_dollars: z.number().nonnegative(),
  miles_total: z.number().int().nonnegative().optional(),
  miles_loaded: z.number().int().nonnegative().optional(),
  source_document_id: z.string().uuid().optional(),
  notes: z.string().min(1).optional(),
  lines: z.array(settlementLineArgs).max(200).default([]),
});

const setPayPinArgs = z.object({
  model: z.enum([
    "percentage_gross", "percentage_net", "cpm_loaded", "cpm_all_miles",
    "flat_per_load", "flat_per_day", "mixed",
  ]),
  rate: z.number().positive().optional(),
  employment: z.enum(["w2", "1099"]).optional(),
  fuel_paid_by: z.enum(["owner", "driver"]).optional(),
  tolls_paid_by: z.enum(["owner", "driver"]).optional(),
  settlement_day: z.string().min(1).optional(),
  tax_setaside_percent: z.number().min(0).max(60).optional(),
  /** Where this pin comes from, in words ("settlement 2026-10-24", "the carrier's message today") - stored on the pin. */
  source: z.string().min(1),
  source_kind: z.enum(["owner_stated", "document"]).default("owner_stated"),
});

import { addDays, mondayOf } from "./pay-report";

const setPayTermsArgs = z.object({
  employer_name: z.string().trim().min(1),
  rate_dollars_per_mile: z.number().nonnegative().optional(),
  mile_basis: z.enum(["loaded", "all", "practical"]).optional(),
  worker_type: z.enum(["w2", "1099"]).optional(),
  fuel_paid_by: z.enum(["employer", "driver"]).optional(),
});

export function buildPayTools(store: BotBrainStore): AgentTool[] {
  const { client, companyId } = store;

  return [
    {
      name: "set_pay_terms",
      description:
        "Change his stored pay TERMS for an employer (Settings > Pay terms): rate in dollars per mile, which miles are paid (loaded / all / practical), W2 vs 1099, who pays fuel. Only set what his words or a document establish - never infer a field he did not state; fields you omit keep their current value (unset stays unset). A change closes the current terms and starts new dated terms, so history is kept. Always a proposal for his yes.",
      parameters: {
        type: "object",
        properties: {
          employer_name: { type: "string" },
          rate_dollars_per_mile: { type: "number", description: "Dollars per mile, e.g. 0.55." },
          mile_basis: { type: "string", enum: ["loaded", "all", "practical"] },
          worker_type: { type: "string", enum: ["w2", "1099"] },
          fuel_paid_by: { type: "string", enum: ["employer", "driver"] },
        },
        required: ["employer_name"],
      },
      access: "write",
      alwaysPropose: true,
      validateArgs: validateWith(setPayTermsArgs),
      summarize(args) {
        const a = setPayTermsArgs.parse(args);
        const bits = [
          a.rate_dollars_per_mile != null ? `$${a.rate_dollars_per_mile.toFixed(2)}/mile` : null,
          a.mile_basis ? `${a.mile_basis} miles` : null,
          a.worker_type ?? null,
          a.fuel_paid_by ? `fuel: ${a.fuel_paid_by}` : null,
        ].filter(Boolean);
        return `Pay terms for ${a.employer_name}: ${bits.join(", ") || "no change"} (starts new dated terms)`;
      },
      async run(args) {
        const a = setPayTermsArgs.parse(args);
        const { data, error } = await client
          .from("employer_pay_profiles")
          .select("*")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .is("effective_to", null)
          .ilike("employer_name", a.employer_name);
        if (error) throw new Error(error.message);
        const cur = ((data ?? []) as Array<Record<string, unknown>>).find(
          (r) => String(r.employer_name).trim().toLowerCase() === a.employer_name.trim().toLowerCase(),
        );
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
        const rateCents =
          a.rate_dollars_per_mile != null
            ? Math.round(a.rate_dollars_per_mile * 100)
            : (cur?.rate_cents_per_mile as number | undefined);
        if (rateCents === undefined) throw new Error("No rate on file for that employer - tell me the dollars per mile.");
        if (cur) {
          const { error: closeError } = await client
            .from("employer_pay_profiles")
            .update({ effective_to: today })
            .eq("id", cur.id as string)
            .eq("company_id", companyId);
          if (closeError) throw new Error(closeError.message);
        }
        const { error: insertError } = await client.from("employer_pay_profiles").insert({
          company_id: companyId,
          employer_name: (cur?.employer_name as string | undefined) ?? a.employer_name,
          rate_cents_per_mile: rateCents,
          mile_basis: a.mile_basis ?? (cur?.mile_basis as string | null | undefined) ?? null,
          worker_type: a.worker_type ?? (cur?.worker_type as string | null | undefined) ?? null,
          fuel_paid_by: a.fuel_paid_by ?? (cur?.fuel_paid_by as string | null | undefined) ?? null,
          effective_from: today,
        });
        if (insertError) throw new Error(insertError.message);
        return `Updated pay terms for ${a.employer_name}; the earlier terms are kept in the history.`;
      },
    },
    {
      name: "get_pay_status",
      description:
        "His pay truth at a glance: the pinned pay structure (or the fact it is NOT pinned yet), the latest settlement's true-pay figures, and - while unpinned - which pay models the latest settlement's math actually fits, plus the open questions that would pin it down. Call this before answering ANY question about what he makes.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const pin = await store.loadPayPin();
        const settlements = await store.listSettlements(3);
        const lines: string[] = [];
        if (!isPinned(pin)) {
          lines.push(
            "PAY STRUCTURE: NOT PINNED. He is earning under a structure nobody has confirmed - never state one pay model as his.",
          );
          const latest = settlements[0];
          if (latest) {
            const candidates = candidateModels(latest, 0);
            lines.push(
              `The latest settlement (${latest.issuerName}, ${latest.periodStart} to ${latest.periodEnd}, his pay ${dollars(latest.driverPayCents)}) fits these models:`,
            );
            for (const c of candidates) {
              lines.push(`- ${c.model} at ${c.impliedRate}${c.model.startsWith("percentage") ? "%" : c.model.startsWith("cpm") ? "/mi" : ""} - ${c.note}`);
            }
            lines.push(
              "Propose the pin with set_pay_pin (confirmation \"propose\") showing this working, or coach him to ask his carrier the structure questions (percentage of what? W2 or 1099? who pays fuel/tolls? settle day?).",
            );
          } else {
            lines.push(
              "No settlement is recorded yet either. One settlement photo (or his carrier's answer about the structure) is enough to propose the pin.",
            );
          }
        } else {
          lines.push(
            `PAY PIN: model ${pin.model}${pin.rate != null ? ` at ${pin.rate}` : ""}; employment ${pin.employment}; fuel paid by ${pin.fuelPaidBy}, tolls paid by ${pin.tollsPaidBy}${pin.settlementDay ? `; settles ${pin.settlementDay}` : ""}${pin.source ? ` (source: ${pin.source})` : ""}.`,
          );
          const latest = settlements[0];
          if (latest) {
            lines.push(
              `Latest settlement: ${latest.issuerName}, ${latest.periodStart} to ${latest.periodEnd} - gross ${dollars(latest.grossCents)}, his pay ${dollars(latest.driverPayCents)}, pin check: ${latest.pinCheck}${latest.pinCheckDetail ? ` (${latest.pinCheckDetail})` : ""}.`,
            );
          } else {
            lines.push("No settlement recorded against the pin yet - the first one gets checked against it automatically.");
          }
        }
        return lines.join("\n");
      },
    },
    {
      name: "extract_settlement",
      description:
        "Read a settlement DOCUMENT's stored text into a structured draft (issuer, period, gross, every line, his pay, miles) - the first step when he photographs a settlement. Get the document id from list_documents / get_document. Returns the draft ONLY: nothing is recorded; afterwards call record_settlement with confirmation \"propose\" so he approves the record.",
      parameters: {
        type: "object",
        properties: { document_id: { type: "string", description: "The document's id (uuid)." } },
        required: ["document_id"],
      },
      access: "read",
      async run(args) {
        const documentId = String(args.document_id ?? "");
        const { data, error } = await client
          .from("documents")
          .select("id, file_name, doc_type, extracted_text")
          .eq("id", documentId)
          .eq("company_id", companyId)
          .maybeSingle();
        if (error) throw new Error(error.message);
        const doc = data as { file_name: string; doc_type: string | null; extracted_text: string | null } | null;
        if (!doc) throw new Error(`No document with id ${documentId} in his records.`);
        if (!doc.extracted_text) {
          return `That document (${doc.file_name}) has no extracted text yet - either document text extraction is off, or the read is still pending/failed. I can't structure a settlement from it until its text exists; he can check it under More -> Documents.`;
        }
        const extraction = await extractSettlementStructure(new OpenAiProvider(), doc.extracted_text);
        // Match printed load references to his recorded loads so the
        // record_settlement lines can carry real load ids.
        const { data: loads } = await client
          .from("loads")
          .select("id, origin, destination")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(50);
        const loadRows = (loads ?? []) as { id: string; origin: string; destination: string }[];
        const matches: string[] = [];
        for (const line of extraction.lines) {
          if (!line.load_reference) continue;
          const ref = line.load_reference.toLowerCase();
          const hit = loadRows.find(
            (l) =>
              ref.includes(l.origin.toLowerCase()) && ref.includes(l.destination.toLowerCase()),
          );
          if (hit) matches.push(`- "${line.load_reference}" -> load ${hit.id} (${hit.origin} → ${hit.destination})`);
        }
        return (
          formatSettlementExtraction(extraction) +
          (matches.length > 0
            ? `\nLoad references matched to his records:\n${matches.join("\n")}`
            : "\nNo printed load reference matched a recorded load - record the lines without load ids rather than guessing one.")
        );
      },
    },
    {
      name: "record_settlement",
      description:
        "Record a settlement statement in his books (Money truth, not an expense): issuer, period, gross, his pay line, miles, and every itemized line (signed dollars - deductions negative; link lines to loads with load_id when known). Code computes the true-pay figures (tax set-aside, spendable, $/all-miles, $/duty-hour) and checks the math against the pay pin - a mismatch is reported back, never hidden. Stage with confirmation \"propose\" unless he ordered the recording directly.",
      parameters: {
        type: "object",
        properties: {
          issuer_name: { type: "string" },
          period_start: { type: "string", description: "YYYY-MM-DD" },
          period_end: { type: "string", description: "YYYY-MM-DD" },
          gross_dollars: { type: "number" },
          carrier_cut_dollars: { type: "number" },
          net_to_truck_dollars: { type: "number" },
          driver_pay_dollars: { type: "number" },
          miles_total: { type: "number", description: "All miles in the period (loaded + empty)." },
          miles_loaded: { type: "number" },
          source_document_id: { type: "string", description: "The settlement document's id, when it came from one." },
          notes: { type: "string" },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["load_pay", "carrier_cut", "fuel", "tolls", "advance", "factoring", "detention", "layover", "escrow", "insurance", "dispatch_fee", "other_earning", "other_deduction"] },
                label: { type: "string" },
                amount_dollars: { type: "number", description: "Signed: earnings positive, deductions negative." },
                load_id: { type: "string" },
              },
              required: ["kind", "label", "amount_dollars"],
            },
          },
        },
        required: ["issuer_name", "period_start", "period_end", "gross_dollars", "driver_pay_dollars"],
      },
      access: "write",
      validateArgs: validateWith(recordSettlementArgs),
      summarize(args) {
        const parsed = recordSettlementArgs.parse(args);
        return `Settlement: ${parsed.issuer_name} ${parsed.period_start} to ${parsed.period_end} - gross ${dollars(cents(parsed.gross_dollars))}, his pay ${dollars(cents(parsed.driver_pay_dollars))}, ${parsed.lines.length} line(s)`;
      },
      async run(args) {
        const parsed = recordSettlementArgs.parse(args);
        const recorded = await store.recordSettlement({
          issuerName: parsed.issuer_name,
          periodStart: parsed.period_start,
          periodEnd: parsed.period_end,
          grossCents: cents(parsed.gross_dollars),
          carrierCutCents: parsed.carrier_cut_dollars != null ? cents(parsed.carrier_cut_dollars) : null,
          netToTruckCents: parsed.net_to_truck_dollars != null ? cents(parsed.net_to_truck_dollars) : null,
          driverPayCents: cents(parsed.driver_pay_dollars),
          milesTotal: parsed.miles_total ?? null,
          milesLoaded: parsed.miles_loaded ?? null,
          dutyMinutes: null,
          sourceDocumentId: parsed.source_document_id ?? null,
          notes: parsed.notes ?? null,
          lines: parsed.lines.map((line) => ({
            kind: line.kind,
            label: line.label,
            amountCents: cents(line.amount_dollars),
            loadId: line.load_id ?? null,
          })),
        });
        const out = [
          `Recorded settlement ${parsed.issuer_name} ${parsed.period_start} to ${parsed.period_end}: gross ${dollars(cents(parsed.gross_dollars))}, his pay ${dollars(cents(parsed.driver_pay_dollars))}. Record id ${recorded.id}.`,
          `Pin check: ${recorded.pinCheck}${recorded.pinCheckDetail ? ` - ${recorded.pinCheckDetail}` : ""}`,
          ...recorded.truePayLines,
        ];
        return out.join("\n");
      },
    },
    {
      name: "set_pay_pin",
      description:
        "Pin his pay structure - the model's answer to 'what IS his structure?' - as a dated, sourced fact. Only pin what his words or a document actually establish: model (percentage_gross / percentage_net / cpm_loaded / cpm_all_miles / flat_per_load / flat_per_day / mixed), the rate, W2 vs 1099, who pays fuel and tolls, settle day, and the SOURCE in words. A pin from a settlement's math gets proposed (confirmation \"propose\") with the fit shown first via get_pay_status; a pin he states himself can execute on his direct order. A new pin replaces the old one as current; the old stays in history.",
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", enum: ["percentage_gross", "percentage_net", "cpm_loaded", "cpm_all_miles", "flat_per_load", "flat_per_day", "mixed"] },
          rate: { type: "number", description: "Percent (30 = 30%) for percentage models; dollars/mile for CPM; dollars for flat." },
          employment: { type: "string", enum: ["w2", "1099"] },
          fuel_paid_by: { type: "string", enum: ["owner", "driver"] },
          tolls_paid_by: { type: "string", enum: ["owner", "driver"] },
          settlement_day: { type: "string", description: "Weekday name, e.g. Friday." },
          tax_setaside_percent: { type: "number", description: "1099 set-aside percent for the weekly report (default 25)." },
          source: { type: "string", description: "Where this pin comes from, in words." },
          source_kind: { type: "string", enum: ["owner_stated", "document"] },
        },
        required: ["model", "source"],
      },
      access: "write",
      validateArgs: validateWith(setPayPinArgs),
      summarize(args) {
        const parsed = setPayPinArgs.parse(args);
        return `Pay pin: ${parsed.model}${parsed.rate != null ? ` at ${parsed.rate}` : ""}${parsed.employment ? `, ${parsed.employment}` : ""} (source: ${parsed.source})`;
      },
      async run(args) {
        const parsed = setPayPinArgs.parse(args);
        const current = await store.loadPayPin();
        const pin: PayPin = {
          model: parsed.model,
          rate: parsed.rate ?? null,
          employment: parsed.employment ?? current.employment,
          fuelPaidBy: parsed.fuel_paid_by ?? current.fuelPaidBy,
          tollsPaidBy: parsed.tolls_paid_by ?? current.tollsPaidBy,
          settlementDay: parsed.settlement_day ?? current.settlementDay,
          taxSetasidePercent: parsed.tax_setaside_percent ?? current.taxSetasidePercent,
          source: parsed.source,
          pinnedAt: new Date().toISOString().slice(0, 10),
        };
        await store.saveMemory("business_fact", formatPayPin(pin), {
          provenance: parsed.source_kind === "document" ? "document" : "owner_stated",
        });
        return `Pinned his pay structure: ${pin.model}${pin.rate != null ? ` at ${pin.rate}` : ""}, employment ${pin.employment}, fuel by ${pin.fuelPaidBy}, tolls by ${pin.tollsPaidBy}${pin.settlementDay ? `, settles ${pin.settlementDay}` : ""} (source: ${pin.source}). The previous pin, if any, is closed as history - this one is current.`;
      },
    },
    {
      name: "weekly_pay_report",
      description:
        "The weekly true-pay report, computed in code from his settlement rows: what the loads grossed, the carrier's cut, his pay, tax set-aside and spendable, $/mile and $/duty-hour, deadhead share, and the same loads priced under his own authority (labeled estimate). week_offset 0 = this week so far, 1 = last full week (default). Figures reconcile to the settlement rows to the cent.",
      parameters: {
        type: "object",
        properties: {
          week_offset: { type: "number", description: "0 = current week, 1 = last full week. Default 1." },
        },
      },
      access: "read",
      async run(args) {
        const offset = typeof args.week_offset === "number" ? Math.max(0, Math.min(4, Math.floor(args.week_offset))) : 1;
        const thisMonday = mondayOf(new Date());
        const weekStart = addDays(thisMonday, -7 * offset);
        const weekEnd = addDays(weekStart, 6);
        const [settlements, loads, pin] = await Promise.all([
          store.listSettlementsInRange(weekStart, weekEnd),
          store.listCompletedLoadsInRange(weekStart, weekEnd),
          store.loadPayPin(),
        ]);
        const report = buildWeeklyPayReport({
          weekLabel: `week of ${weekStart} to ${weekEnd}`,
          settlements,
          completedLoads: loads,
          pin,
        });
        return report.text;
      },
    },
    {
      name: "explain_load_pay",
      description:
        "Walk one completed load's money like a lesson (the lease-on economics explainer): what it grossed, what the carrier's cut was (actual from a settlement line when linked, else the TYPICAL lease-on band - always labeled as a general band, never as this carrier's number), the truck's share, his pay (actual, or under the pin), and the same load under his own authority, plus the load's cost in hours against his current clocks. Get the load id from list_loads.",
      parameters: {
        type: "object",
        properties: { load_id: { type: "string" } },
        required: ["load_id"],
      },
      access: "read",
      async run(args) {
        const loadId = String(args.load_id ?? "");
        const { data, error } = await client
          .from("loads")
          .select("id, origin, destination, rate_cents, miles")
          .eq("id", loadId)
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .maybeSingle();
        if (error) throw new Error(error.message);
        const load = data as { origin: string; destination: string; rate_cents: number | null; miles: number | null } | null;
        if (!load) throw new Error(`No load with id ${loadId} in his records.`);
        if (load.rate_cents == null) {
          return `That load (${load.origin} → ${load.destination}) has no rate recorded, so there's no money walk to do - the rate con's figure is what it needs.`;
        }
        const { data: lineRows } = await client
          .from("settlement_lines")
          .select("kind, amount_cents")
          .eq("company_id", companyId)
          .eq("load_id", loadId)
          .is("deleted_at", null);
        const lines = (lineRows ?? []) as { kind: string; amount_cents: number }[];
        const sumKind = (kind: string) =>
          lines.filter((l) => l.kind === kind).reduce((t, l) => t + l.amount_cents, 0);
        const actualPay = lines.some((l) => l.kind === "load_pay") ? sumKind("load_pay") : null;
        const actualCut = lines.some((l) => l.kind === "carrier_cut") ? Math.abs(sumKind("carrier_cut")) : null;
        const pin = await store.loadPayPin();
        const economics = explainLoadEconomics({
          origin: load.origin,
          destination: load.destination,
          grossCents: load.rate_cents,
          miles: load.miles,
          actualPayCents: actualPay,
          actualCarrierCutCents: actualCut,
          pin,
        });
        // The load's cost in hours beside its pay - from the ONE HOS read, never a second implementation.
        let hoursLine: string;
        try {
          const now = new Date();
          const snapshot = await loadHosWindow(client, companyId, now);
          hoursLine = `Hours: ${loadHosCost(load.miles, glanceFromSnapshot(snapshot, now.getTime())).text}`;
        } catch {
          hoursLine = "Hours: your logged hours couldn't be read just now, so I can't say how this load fits them.";
        }
        return [...economics.lines, hoursLine].join("\n");
      },
    },
  ];
}
