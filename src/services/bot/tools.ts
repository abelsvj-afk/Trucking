// Bot intelligence v2 (docs/design/driver-mvp.md §8). The bot's
// tools over the app's own data: one registry used by the agent
// loop on both surfaces (Telegram via the service-role store, web
// via the owner's session store - services/bot/store.ts).
//
// Read tools act freely: it is the owner's own data. Write tools
// are executed by the loop ONLY under the owner's standing rule
// (see services/ai/agent-loop.ts): his direct imperative orders
// execute immediately; bot-proposed writes wait in
// bot_pending_actions for his yes, and executeWriteTool below is
// the only path that runs one after that yes.
//
// Every tool result is grounding text built from the actual query
// result - the loop's grounding guard holds the final reply to
// figures that appear here or in the code-assembled context.

import { z } from "zod";
import { summarizeHos } from "@/lib/hos";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { searchMemoryEverywhere } from "./memory-retrieval";
import { getEmbeddingProvider } from "./embeddings";
import type { DetentionStamp, Document, DutyLog, Expense, Load } from "@/types/entities";
import { computeDetention } from "@/lib/detention";
import { computePaperwork } from "@/lib/paperwork";
import { validateWith } from "./tool-helpers";
import { buildExtendedReadTools } from "./tools-read";
import { buildGameTools } from "./tools-game";
import { buildExtendedWriteTools } from "./tools-write";
import { validateDumpItems } from "./dump-intake";
import { evaluatePayOffer, formatPayEvaluation, payOfferArgs } from "./pay-advisor";
import { buildRouteCheckTool } from "./route-check-tool";
import { buildPayTools } from "./pay-tools";
import { buildThreadTools } from "./thread-tools";
import { buildTwinTools } from "./twin-tools";
import { propagateMileage } from "@/services/fleet/mileage";
import { hosProvenanceLines } from "@/services/fleet/paper-logs";
import { isMissingColumnError } from "./tool-helpers";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, "0")}m`;
}

function moneyLine(label: string, cents: number): string {
  return `${label}: ${dollars(cents)}`;
}

export function buildBotTools(store: BotBrainStore): AgentTool[] {
  const { client, companyId } = store;

  const tools: AgentTool[] = [
    {
      name: "list_loads",
      description:
        "List loads from his records (most recent first). Optionally filter by status: draft, confirmed, or completed. Use for questions about specific loads, lanes, rates, or pickup/delivery dates beyond the snapshot's active loads.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["draft", "confirmed", "completed"] },
        },
      },
      access: "read",
      async run(args) {
        let query = client
          .from("loads")
          .select("id, origin, destination, status, pickup_date, delivery_date, rate_cents, miles")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(20);
        if (typeof args.status === "string") query = query.eq("status", args.status);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Record<string, unknown>[];
        if (rows.length === 0) return "No loads on file matching that.";
        return rows
          .map(
            (r) =>
              `- [${r.id}] ${r.origin} → ${r.destination} (${r.status}` +
              `${r.pickup_date ? `, pickup ${r.pickup_date}` : ""}` +
              `${r.delivery_date ? `, delivery ${r.delivery_date}` : ""}` +
              `${typeof r.rate_cents === "number" ? `, rate ${dollars(r.rate_cents)}` : ""}` +
              `${typeof r.miles === "number" ? `, ${r.miles} mi` : ""})`,
          )
          .join("\n");
      },
    },
    {
      name: "hos_summary",
      description:
        "His current hours-of-service picture from his duty logs (the paper-log helper - not the ELD): current duty status, driving used in the 14-hour window, driving since the last 30-minute break, on-duty in the last 8 days vs 70, and warnings.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const { data, error } = await client
          .from("duty_logs")
          .select("*")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .order("started_at", { ascending: false })
          .limit(100);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as DutyLog[];
        if (rows.length === 0) return "No duty logs on file yet.";
        const hos = summarizeHos(rows);
        const current = [...rows].sort((a, b) => b.started_at.localeCompare(a.started_at))[0]!;
        const lines = [
          `Current duty status: ${current.duty_status} (since ${current.started_at}).`,
          `Driving in current 14h window: ${formatMinutes(hos.drivingMinutesInWindow)} of 11h.`,
          `Window elapsed: ${formatMinutes(hos.windowElapsedMinutes)} of 14h.`,
          `Driving since last 30-min break: ${formatMinutes(hos.drivingMinutesSinceBreak)} of 8h.`,
          `On duty in last 8 days: ${formatMinutes(hos.onDutyMinutesLast8Days)} of 70h.`,
        ];
        if (hos.warnings.length > 0) lines.push(`Warnings: ${hos.warnings.join("; ")}`);
        // §7.7 trust labeling: paper-sourced clocks say so, and a
        // partial paper day says partial - in this surface too.
        lines.push(...(await hosProvenanceLines(client, companyId, rows)));
        return lines.join("\n");
      },
    },
    {
      name: "money_summary",
      description:
        "Expense and fuel totals from his records over the last N days (default 30), with an expense breakdown by category. Pass load_id to see the expenses recorded against one specific load (fuel purchases are not linked to loads in his records - say so if he asks for per-load fuel).",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Lookback window in days, 1-90. Default 30." },
          load_id: { type: "string", description: "Optional load id to scope expenses to one load." },
        },
      },
      access: "read",
      async run(args) {
        const days = Math.min(90, Math.max(1, typeof args.days === "number" ? args.days : 30));
        const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const sinceTs = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        let expenseQuery = client
          .from("expenses")
          .select("category, amount_cents, expense_date, description")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .gte("expense_date", sinceDate)
          .order("expense_date", { ascending: false });
        if (typeof args.load_id === "string") expenseQuery = expenseQuery.eq("load_id", args.load_id);

        const [expenses, fuel] = await Promise.all([
          expenseQuery,
          client
            .from("fuel_purchases")
            .select("total_cost_cents, gallons, purchased_at, location")
            .eq("company_id", companyId)
            .is("deleted_at", null)
            .gte("purchased_at", sinceTs)
            .order("purchased_at", { ascending: false }),
        ]);
        if (expenses.error) throw new Error(expenses.error.message);
        if (fuel.error) throw new Error(fuel.error.message);

        const expenseRows = (expenses.data ?? []) as { category: string; amount_cents: number; expense_date: string; description: string | null }[];
        const fuelRows = (fuel.data ?? []) as { total_cost_cents: number; gallons: number }[];
        const expenseTotal = expenseRows.reduce((t, r) => t + r.amount_cents, 0);
        const fuelTotal = fuelRows.reduce((t, r) => t + r.total_cost_cents, 0);

        const lines = [
          typeof args.load_id === "string"
            ? `Expenses recorded against load ${args.load_id} in the last ${days} days:`
            : `Money in the last ${days} days (from his records):`,
          moneyLine("Expenses total", expenseTotal),
        ];
        const byCategory = new Map<string, number>();
        for (const row of expenseRows) byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + row.amount_cents);
        for (const [category, cents] of byCategory) lines.push(`- ${category}: ${dollars(cents)}`);
        if (typeof args.load_id !== "string") {
          lines.push(moneyLine(`Fuel total (${fuelRows.length} purchases)`, fuelTotal));
        } else {
          lines.push("Fuel purchases are not linked to individual loads in his records, so no per-load fuel figure exists.");
        }
        return lines.join("\n");
      },
    },
    {
      name: "list_contacts",
      description: "List his contacts of one kind: brokers, customers, or drivers - names and total count.",
      parameters: {
        type: "object",
        properties: { kind: { type: "string", enum: ["brokers", "customers", "drivers"] } },
        required: ["kind"],
      },
      access: "read",
      async run(args) {
        const kind = args.kind as "brokers" | "customers" | "drivers";
        const { data, error, count } = await client
          .from(kind)
          .select("name", { count: "exact" })
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .order("name", { ascending: true })
          .limit(50);
        if (error) throw new Error(error.message);
        const names = ((data ?? []) as { name: string }[]).map((r) => r.name);
        return `${kind} on file (${count ?? names.length}): ${names.join(", ") || "none"}`;
      },
    },
    {
      name: "list_documents",
      description: "List his most recent documents on file (BOLs, paperwork photos, etc.) - id, file name, what they're attached to, and when they were added. Use get_document to read a document's actual content.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        // documents has no deleted_at column (hard-delete table,
        // docs/schemas.md) - never filter on it (design §9; §8's
        // version of this tool did, which the real database rejects).
        const { data, error } = await client
          .from("documents")
          .select("id, file_name, related_entity_type, created_at")
          .eq("company_id", companyId)
          .order("created_at", { ascending: false })
          .limit(15);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as { id: string; file_name: string; related_entity_type: string; created_at: string }[];
        if (rows.length === 0) return "No documents on file yet.";
        return rows.map((r) => `- [${r.id}] ${r.file_name} (attached to ${r.related_entity_type}, added ${r.created_at.slice(0, 10)})`).join("\n");
      },
    },
    {
      // Lane 2 (Phase A): hybrid search over EVERYTHING - memories
      // (including superseded history), past conversation turns, and
      // documents - not just the newest 100 memories. Registered
      // under both names: search_memory is the design's name;
      // search_memories is the historical one the prompt and the
      // owner's habits already know.
      name: "search_memory",
      description: "Search Abel's whole memory by meaning and keywords: long-term memories (current AND superseded), past conversation turns, and document text. Use whenever he refers to something said, sent, or saved before that isn't in this turn's context blocks - search rather than guess, and rather than saying you don't remember.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      access: "read",
      async run(args) {
        const query = String(args.query ?? "").trim();
        if (!query) return "Give me a word, name, or topic to search memory for.";
        const hits = await searchMemoryEverywhere(client, companyId, query, {
          embedder: getEmbeddingProvider(),
        });
        if (hits.length === 0) return `Nothing in memory matches "${query}" - not in memories, past messages, or documents.`;
        return hits
          .map((h) => `- [${h.source}, ${h.created_at.slice(0, 10)}] ${h.snippet}`)
          .join("\n");
      },
    },
    {
      name: "search_memories",
      description: "Alias of search_memory (hybrid search over memories, past turns, and documents). Prefer search_memory.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      access: "read",
      async run(args) {
        const query = String(args.query ?? "").trim();
        if (!query) return "Give me a word, name, or topic to search memory for.";
        const hits = await searchMemoryEverywhere(client, companyId, query, {
          embedder: getEmbeddingProvider(),
        });
        if (hits.length === 0) return `Nothing in memory matches "${query}" - not in memories, past messages, or documents.`;
        return hits
          .map((h) => `- [${h.source}, ${h.created_at.slice(0, 10)}] ${h.snippet}`)
          .join("\n");
      },
    },
    {
      name: "search_dispatch_exchanges",
      description: "Search past dispatch exchanges (messages he got help with, and what was suggested) by keyword. Use to recall how a similar message was handled before.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      access: "read",
      async run(args) {
        const query = String(args.query ?? "").trim();
        if (!query) return "Give me a word or phrase to search past dispatch messages for.";
        const { data, error } = await client
          .from("dispatch_exchanges")
          .select("incoming_message, ai_translation, created_at, source")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .ilike("incoming_message", `%${query}%`)
          .order("created_at", { ascending: false })
          .limit(8);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as { incoming_message: string; ai_translation: string | null; created_at: string; source: string }[];
        if (rows.length === 0) return `No past dispatch exchanges mention "${query}".`;
        return rows
          .map((r) => `- (${r.created_at.slice(0, 10)}, via ${r.source}) "${r.incoming_message}"${r.ai_translation ? ` → ${r.ai_translation}` : ""}`)
          .join("\n");
      },
    },
    {
      name: "create_expense",
      description: "Record an expense in his books (Money). Use when he tells you about money he spent on the business. Link it to a load/truck/driver when he names one (ids from the list tools).",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["insurance", "permits", "repairs", "other"] },
          amount_dollars: { type: "number", description: "Amount spent, in dollars." },
          description: { type: "string" },
          expense_date: { type: "string", description: "Date spent, YYYY-MM-DD. Defaults to today." },
          load_id: { type: "string", description: "Load id (uuid) this expense belongs to, if any." },
          truck_id: { type: "string", description: "Truck id (uuid) this expense belongs to, if any." },
          driver_id: { type: "string", description: "Driver id (uuid) this expense belongs to, if any." },
        },
        required: ["category", "amount_dollars"],
      },
      access: "write",
      validateArgs: validateWith(createExpenseArgs),
      summarize(args) {
        const parsed = createExpenseArgs.parse(args);
        return `Expense: ${dollars(Math.round(parsed.amount_dollars * 100))} (${parsed.category})${parsed.description ? ` — ${parsed.description}` : ""} on ${parsed.expense_date ?? "today"}`;
      },
      async run(args) {
        const parsed = createExpenseArgs.parse(args);
        const expenseDate = parsed.expense_date ?? new Date().toISOString().slice(0, 10);
        const { data, error } = await client
          .from("expenses")
          .insert({
            company_id: companyId,
            category: parsed.category,
            amount_cents: Math.round(parsed.amount_dollars * 100),
            expense_date: expenseDate,
            description: parsed.description ?? null,
            load_id: parsed.load_id ?? null,
            truck_id: parsed.truck_id ?? null,
            driver_id: parsed.driver_id ?? null,
          })
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        return `Recorded expense ${dollars(Math.round(parsed.amount_dollars * 100))} (${parsed.category}) on ${expenseDate}. Record id ${(data as { id: string }).id}.`;
      },
    },
    {
      name: "create_fuel_purchase",
      description: "Record a fuel purchase in his books. Needs the total paid and gallons; pass truck_id when he names the truck (from list_trucks) - otherwise, if he has exactly one truck on file, that truck is used. ODOMETER (§5.3): when he gives the dash reading at the pump, pass it - it updates the truck's mileage with provenance. When he doesn't give one, you may ask once; a fuel entry WITHOUT an odometer is always fine and must never be blocked or nagged about.",
      parameters: {
        type: "object",
        properties: {
          total_dollars: { type: "number", description: "Total paid at the pump, in dollars." },
          gallons: { type: "number" },
          location: { type: "string", description: "Station / city, if he said." },
          state: { type: "string", description: "Two-letter state where the fuel was bought (IFTA), if known." },
          truck_id: { type: "string", description: "Truck id (uuid), if he named the truck." },
          purchased_at: { type: "string", description: "ISO timestamp of the purchase. Defaults to now." },
          odometer: { type: "number", description: "Dash odometer reading at this fuel stop, if he gave one." },
        },
        required: ["total_dollars", "gallons"],
      },
      access: "write",
      validateArgs: validateWith(createFuelArgs),
      summarize(args) {
        const parsed = createFuelArgs.parse(args);
        return `Fuel purchase: ${dollars(Math.round(parsed.total_dollars * 100))} for ${parsed.gallons} gal${parsed.location ? ` at ${parsed.location}` : ""}`;
      },
      async run(args) {
        const parsed = createFuelArgs.parse(args);
        const { data: trucks, error: trucksError } = await client
          .from("trucks")
          .select("id, unit_number")
          .eq("company_id", companyId)
          .is("deleted_at", null);
        if (trucksError) throw new Error(trucksError.message);
        const truckRows = (trucks ?? []) as { id: string; unit_number: string }[];
        if (truckRows.length === 0) throw new Error("No truck on file to attach the fuel purchase to.");
        let truck = truckRows[0]!;
        if (parsed.truck_id) {
          const named = truckRows.find((t) => t.id === parsed.truck_id);
          if (!named) throw new Error(`No truck with id ${parsed.truck_id} in his records.`);
          truck = named;
        } else if (truckRows.length > 1) {
          throw new Error(
            `More than one truck on file (${truckRows.map((t) => t.unit_number).join(", ")}) - ask him which truck this fuel went into.`,
          );
        }
        const totalCents = Math.round(parsed.total_dollars * 100);
        const baseRow: Record<string, unknown> = {
          company_id: companyId,
          truck_id: truck.id,
          location: parsed.location ?? null,
          gallons: parsed.gallons,
          price_per_gallon_cents: Math.round(totalCents / parsed.gallons),
          total_cost_cents: totalCents,
          purchased_at: parsed.purchased_at ?? new Date().toISOString(),
        };
        // The odometer column arrives with migration 00042 - only
        // send it when he actually gave a reading, and if the
        // column isn't live yet, land the fuel entry anyway and
        // say the reading itself wasn't saved (§5.3 honesty).
        let odometerUnsaved = false;
        if (parsed.odometer !== undefined) baseRow.odometer = parsed.odometer;
        let { data, error } = await client
          .from("fuel_purchases")
          .insert(baseRow)
          .select("id")
          .single();
        if (error && parsed.odometer !== undefined && isMissingColumnError(error)) {
          delete baseRow.odometer;
          odometerUnsaved = true;
          ({ data, error } = await client.from("fuel_purchases").insert(baseRow).select("id").single());
        }
        if (error) throw new Error(error.message);
        let mileageNote = "";
        if (parsed.odometer !== undefined && !odometerUnsaved) {
          const outcome = await propagateMileage(client, companyId, {
            truckId: truck.id,
            miles: parsed.odometer,
            source: "fuel_entry",
          });
          mileageNote = outcome.applied
            ? ` Truck mileage now ${Math.round(parsed.odometer).toLocaleString("en-US")} (from this fuel stop).`
            : ` The pump reading (${Math.round(parsed.odometer).toLocaleString("en-US")}) is below the truck's recorded ${outcome.previousMiles?.toLocaleString("en-US") ?? "mileage"}, so the recorded mileage stays.`;
        } else if (odometerUnsaved) {
          mileageNote = " The odometer reading wasn't saved - the mileage column hasn't landed in the database yet; the fuel entry itself is recorded.";
        }
        return `Recorded fuel purchase ${dollars(totalCents)} for ${parsed.gallons} gal on truck ${truck.unit_number}. Record id ${(data as { id: string }).id}.${mileageNote}`;
      },
    },
    {
      name: "log_duty_status",
      description: "Log a duty-status change in his paper-log helper (NOT the ELD - the helper never replaces the legal record): off_duty, sleeper, driving, or on_duty. Starts now unless he names a start time. Provenance: omit source for ordinary entries; when he dictates hours in words to fill a gap a paper sheet read couldn't resolve, pass source 'conversation' (his word, not a read); 'paper_photo' rows are staged by the sheet pipeline itself, never invented in conversation. Correcting an entry that came from a paper sheet changes only the app's mirror - his paper still says the old time until he re-marks it, and any proposal to change one must say so.",
      parameters: {
        type: "object",
        properties: {
          duty_status: { type: "string", enum: ["off_duty", "sleeper", "driving", "on_duty"] },
          location: { type: "string" },
          notes: { type: "string" },
          started_at: { type: "string", description: "ISO timestamp the status began. Defaults to now." },
          odometer: { type: "number", description: "Odometer reading at the change, if he gave one." },
          load_id: { type: "string", description: "Load id (uuid) this duty period belongs to, if any." },
        },
        required: ["duty_status"],
      },
      access: "write",
      validateArgs: validateWith(logDutyArgs),
      summarize(args) {
        const parsed = logDutyArgs.parse(args);
        return `Duty status: ${parsed.duty_status} starting ${parsed.started_at ? `at ${parsed.started_at}` : "now"}${parsed.location ? ` in ${parsed.location}` : ""} (paper-log helper)`;
      },
      async run(args) {
        const parsed = logDutyArgs.parse(args);
        const baseRow: Record<string, unknown> = {
          company_id: companyId,
          duty_status: parsed.duty_status,
          started_at: parsed.started_at ?? new Date().toISOString(),
          location: parsed.location ?? null,
          notes: parsed.notes ?? null,
          odometer: parsed.odometer ?? null,
          load_id: parsed.load_id ?? null,
        };
        if (parsed.source !== undefined) baseRow.source = parsed.source;
        if (parsed.source_document_id !== undefined) {
          baseRow.source_document_id = parsed.source_document_id;
        }
        let { error } = await client.from("duty_logs").insert(baseRow);
        if (error && parsed.source !== undefined && isMissingColumnError(error)) {
          // Pre-00044 database: the entry still lands; provenance
          // is restated in the note so the mirror stays honest
          // about where the row came from.
          delete baseRow.source;
          delete baseRow.source_document_id;
          baseRow.notes = `${baseRow.notes ? `${baseRow.notes} ` : ""}(Provenance: ${parsed.source} - the source columns haven't landed in the database yet.)`;
          ({ error } = await client.from("duty_logs").insert(baseRow));
        }
        if (error) throw new Error(error.message);
        // §5.3: a duty-log odometer is an observation of the
        // truck's mileage - through the load's truck, via the one
        // propagation door. Without a load there's no truck to
        // attribute it to, and that is said out loud.
        let mileageNote = "";
        if (parsed.odometer !== undefined) {
          if (parsed.load_id) {
            const { data: load } = await client
              .from("loads")
              .select("truck_id")
              .eq("id", parsed.load_id)
              .eq("company_id", companyId)
              .is("deleted_at", null)
              .maybeSingle();
            const truckId = (load as { truck_id: string | null } | null)?.truck_id;
            if (truckId) {
              const outcome = await propagateMileage(client, companyId, {
                truckId,
                miles: parsed.odometer,
                source: "duty_log",
              });
              mileageNote = outcome.applied
                ? ` Truck mileage now ${parsed.odometer.toLocaleString("en-US")} (from this log entry).`
                : ` The log's odometer (${parsed.odometer.toLocaleString("en-US")}) is below the truck's recorded ${outcome.previousMiles?.toLocaleString("en-US") ?? "mileage"}, so the recorded mileage stays.`;
            }
          } else {
            mileageNote = " That entry isn't tied to a load, so the truck's mileage didn't move from it.";
          }
        }
        const { data } = await client
          .from("duty_logs")
          .select("*")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .order("started_at", { ascending: false })
          .limit(100);
        const rows = (data ?? []) as DutyLog[];
        const hos = rows.length > 0 ? summarizeHos(rows) : null;
        return (
          `Logged duty status ${parsed.duty_status} starting now in the paper-log helper.` +
          (hos
            ? ` Helper now shows: driving in window ${formatMinutes(hos.drivingMinutesInWindow)} of 11h; on duty in 8 days ${formatMinutes(hos.onDutyMinutesLast8Days)} of 70h.`
            : "") +
          mileageNote
        );
      },
    },
    // GAP-04: the facility clock. "I'm at the receiver, checked in"
    // is a stamp, not a form — this tool writes it and reports the
    // running detention math from lib/detention.ts.
    {
      name: "stamp_detention",
      description:
        "Stamp a load's detention (facility) clock: arrival, door, loading_done, or departure at the pickup or delivery stop. Use when he says he's arrived / checked in / at the door / loaded or unloaded / leaving a facility. Defaults to now and the delivery stop. Returns the detention owed so far from the load's terms.",
      parameters: {
        type: "object",
        properties: {
          load_id: { type: "string", description: "Load id (uuid) — from list_loads." },
          stamp_type: { type: "string", enum: ["arrival", "door", "loading_done", "departure"] },
          stop_kind: { type: "string", enum: ["pickup", "delivery"], description: "Which stop. Defaults to delivery." },
          occurred_at: { type: "string", description: "ISO timestamp if he's correcting a time; defaults to now." },
        },
        required: ["load_id", "stamp_type"],
      },
      access: "write",
      validateArgs: validateWith(stampDetentionArgs),
      summarize(args) {
        const parsed = stampDetentionArgs.parse(args);
        return `Detention stamp: ${parsed.stamp_type} (${parsed.stop_kind ?? "delivery"}) on load ${parsed.load_id}`;
      },
      async run(args) {
        const parsed = stampDetentionArgs.parse(args);
        const { data: loadData, error: loadError } = await client
          .from("loads")
          .select("*")
          .eq("company_id", companyId)
          .eq("id", parsed.load_id)
          .is("deleted_at", null)
          .maybeSingle();
        if (loadError) throw new Error(loadError.message);
        if (!loadData) throw new Error("That load isn't in his records.");
        const { error } = await client.from("detention_stamps").insert({
          company_id: companyId,
          load_id: parsed.load_id,
          stamp_type: parsed.stamp_type,
          stop_kind: parsed.stop_kind ?? "delivery",
          occurred_at: parsed.occurred_at ?? new Date().toISOString(),
        });
        if (error) throw new Error(error.message);
        const { data: stamps } = await client
          .from("detention_stamps")
          .select("*")
          .eq("company_id", companyId)
          .eq("load_id", parsed.load_id)
          .is("deleted_at", null)
          .order("occurred_at", { ascending: true });
        const summary = computeDetention(loadData as Load, (stamps ?? []) as DetentionStamp[]);
        const load = loadData as Load;
        let line = `Stamped ${parsed.stamp_type} at the ${parsed.stop_kind ?? "delivery"} for ${load.origin} → ${load.destination}.`;
        if (summary.totalOwedCents != null && summary.totalOwedCents > 0) {
          line += ` Detention owed so far: ${dollars(summary.totalOwedCents)} (${summary.totalBillableHours} billable hr past ${summary.freeMinutes} free min).`;
        } else if (summary.anyClockOpen) {
          line += " The detention clock is running.";
        }
        return line;
      },
    },
    // GAP-05: paperwork state for a load — the closeout checklist.
    {
      name: "get_load_paperwork",
      description:
        "Check a load's paperwork completeness: rate confirmation, BOL/proof of delivery, scale ticket (when the load carries weight), lumper receipt (when a lumper expense is booked). Use when he asks what's missing on a load or before calling a load done.",
      parameters: {
        type: "object",
        properties: {
          load_id: { type: "string", description: "Load id (uuid) — from list_loads." },
        },
        required: ["load_id"],
      },
      access: "read",
      validateArgs: validateWith(loadIdArgs),
      async run(args) {
        const parsed = loadIdArgs.parse(args);
        const { data: loadData, error: loadError } = await client
          .from("loads")
          .select("*")
          .eq("company_id", companyId)
          .eq("id", parsed.load_id)
          .is("deleted_at", null)
          .maybeSingle();
        if (loadError) throw new Error(loadError.message);
        if (!loadData) return "That load isn't in his records.";
        const load = loadData as Load;
        const [docsResult, expensesResult] = await Promise.all([
          client
            .from("documents")
            .select("id, doc_type")
            .eq("company_id", companyId)
            .eq("related_entity_type", "load")
            .eq("related_entity_id", load.id),
          client
            .from("expenses")
            .select("category, description")
            .eq("company_id", companyId)
            .eq("load_id", load.id)
            .is("deleted_at", null),
        ]);
        if (docsResult.error) throw new Error(docsResult.error.message);
        if (expensesResult.error) throw new Error(expensesResult.error.message);
        const state = computePaperwork(
          load,
          (docsResult.data ?? []) as Pick<Document, "id" | "doc_type">[],
          (expensesResult.data ?? []) as Pick<Expense, "category" | "description">[],
        );
        const lines = state.items.map(
          (item) => `- ${item.present ? "✓" : "✗"} ${item.label}${item.present ? "" : ` — ${item.why}`}`,
        );
        return `Paperwork for ${load.origin} → ${load.destination}:\n${lines.join("\n")}\n${state.summaryLine}`;
      },
    },
    // GAP-08: the day-wrap — reconcile the day against its records.
    {
      name: "get_day_wrap",
      description:
        "Run the day-wrap for a date (default today): checks duty entries, fuel against odometer miles, delivered loads' paperwork, detention owed, and proposals waiting. Use when he asks to wrap up the day, check what's missing, or reconcile today.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "YYYY-MM-DD in America/New_York. Omit for today.",
          },
        },
      },
      access: "read",
      validateArgs: validateWith(dayWrapArgs),
      async run(args) {
        const parsed = dayWrapArgs.parse(args);
        const { getDayWrap } = await import("@/services/day-wrap");
        const { easternDate } = await import("@/lib/day-wrap");
        const date = parsed.date ?? easternDate(new Date());
        const result = await getDayWrap(client, companyId, date);
        const lines = result.items.map((item) =>
          item.severity === "ok" ? `✓ ${item.text}` : `- ${item.text}`,
        );
        return `Day-wrap for ${result.date}:\n${lines.join("\n")}`;
      },
    },
    // GAP-11: the credential watch.
    {
      name: "get_credential_watch",
      description:
        "Check expiring credentials (CDL, medical card, inspection, registration, insurance): what's inside 60 days or already expired. Use when he asks what's expiring or before a renewal deadline matters.",
      parameters: { type: "object", properties: {} },
      access: "read",
      validateArgs: validateWith(z.object({})),
      async run() {
        const { credentialAlerts, describeCredentialAlert } = await import("@/lib/credentials");
        const { easternDate } = await import("@/lib/day-wrap");
        const { data, error } = await client
          .from("credentials")
          .select("label, kind, expires_on")
          .eq("company_id", companyId)
          .is("deleted_at", null);
        if (error) throw new Error(error.message);
        const alerts = credentialAlerts(
          (data ?? []) as { label: string; kind: string; expires_on: string }[],
          easternDate(new Date()),
        );
        if (alerts.length === 0) {
          return "Every registered credential is more than 60 days from expiry — nothing on the watch list.";
        }
        return `Credential watch:\n${alerts.map((a) => `- ${describeCredentialAlert(a)}`).join("\n")}`;
      },
    },
    // GAP-12: who owes him, aged.
    {
      name: "get_receivables",
      description:
        "The receivables picture: invoices outstanding, aged against their due dates, late ones named. Dormant while he's lease-on (no invoices exist until he's invoicing brokers himself). Use when he asks who owes him or what's late.",
      parameters: { type: "object", properties: {} },
      access: "read",
      validateArgs: validateWith(z.object({})),
      async run() {
        const { summarizeAging } = await import("@/lib/invoices");
        const { easternDate } = await import("@/lib/day-wrap");
        const { data, error } = await client
          .from("load_invoices")
          .select("amount_cents, paid_amount_cents, due_date")
          .eq("company_id", companyId)
          .is("deleted_at", null);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as { amount_cents: number; paid_amount_cents: number; due_date: string }[];
        if (rows.length === 0) {
          return "No invoices on the books — receivables wake up when he's invoicing brokers under his own authority.";
        }
        const aging = summarizeAging(rows, easternDate(new Date()));
        const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
        return [
          `Outstanding: ${dollars(aging.totalOutstandingCents)}.`,
          `Current: ${dollars(aging.buckets.current.outstandingCents)} · 1–30 late: ${dollars(aging.buckets["1-30"].outstandingCents)} · 31–60: ${dollars(aging.buckets["31-60"].outstandingCents)} · 60+: ${dollars(aging.buckets["60+"].outstandingCents)}.`,
          aging.lateCount > 0
            ? `${aging.lateCount} invoice(s) are past due, ${dollars(aging.lateOutstandingCents)} at stake.`
            : "Nothing past due.",
        ].join("\n");
      },
    },
    // GAP-13: the cash calendar.
    {
      name: "get_cash_calendar",
      description:
        "Project the next 30 days of recurring obligations by week: what's going out, and which week is tightest. Use when he asks what's coming out of the account or plans around settlement timing.",
      parameters: { type: "object", properties: {} },
      access: "read",
      validateArgs: validateWith(z.object({})),
      async run() {
        const { projectObligations } = await import("@/lib/obligations");
        const { easternDate } = await import("@/lib/day-wrap");
        const { data, error } = await client
          .from("recurring_obligations")
          .select("*")
          .eq("company_id", companyId)
          .is("deleted_at", null);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as import("@/types/entities").RecurringObligation[];
        if (rows.length === 0) {
          return "No recurring obligations registered yet — tell me a bill ('phone, $95, on the 12th') and I'll keep its calendar.";
        }
        const projection = projectObligations(rows, easternDate(new Date()), 30);
        const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
        const lines = projection.weeks.map(
          (w) => `- Week of ${w.weekStart}: ${dollars(w.totalCents)} out (${w.occurrences.map((o) => `${o.name} ${dollars(o.amountCents)} on ${o.date}`).join("; ")})`,
        );
        return [
          `Next 30 days: ${dollars(projection.totalCents)} in fixed obligations.`,
          ...lines,
          projection.heaviestWeek
            ? `The tight week is the week of ${projection.heaviestWeek.weekStart} (${dollars(projection.heaviestWeek.totalCents)}).`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    // GAP-14: a broker's working scorecard.
    {
      name: "get_broker_scorecard",
      description:
        "A broker's working record: loads run, average days-to-pay from real invoices, detention raised, money outstanding. Use when he's weighing a new offer from a broker he's run with before.",
      parameters: {
        type: "object",
        properties: {
          broker_id: { type: "string", description: "Broker id (uuid) — from list_brokers." },
        },
        required: ["broker_id"],
      },
      access: "read",
      validateArgs: validateWith(brokerIdArgs),
      async run(args) {
        const { broker_id: brokerId } = brokerIdArgs.parse(args);
        const { getBrokerScorecard } = await import("@/services/broker-scorecard");
        const { describeScorecard } = await import("@/lib/broker-scorecard");
        const { data: broker } = await client
          .from("brokers")
          .select("name")
          .eq("company_id", companyId)
          .eq("id", brokerId)
          .maybeSingle();
        const card = await getBrokerScorecard(client, companyId, brokerId);
        if (!card) return "That broker isn't in his records.";
        return describeScorecard((broker as { name?: string } | null)?.name ?? "That broker", card);
      },
    },
    // GAP-15: the IFTA worksheet.
    {
      name: "get_ifta_worksheet",
      description:
        "The IFTA worksheet for a quarter: gallons by state (exact from his fuel records), attributed intrastate miles, interstate miles honestly unallocated, the quarter's MPG, and anomalies. Use at quarter end or when he asks about fuel tax. Dormant-but-accumulating while lease-on — the carrier files on the truck today; this is his own record and rehearsal.",
      parameters: {
        type: "object",
        properties: {
          quarter: { type: "string", description: "Like 2026Q4. Omit for the current quarter." },
        },
      },
      access: "read",
      validateArgs: validateWith(iftaArgs),
      async run(args) {
        const parsed = iftaArgs.parse(args);
        const { getIftaWorksheet } = await import("@/services/tax-filings");
        const { quarterOf } = await import("@/lib/ifta");
        const { easternDate } = await import("@/lib/day-wrap");
        const quarter = parsed.quarter ?? quarterOf(easternDate(new Date()));
        const sheet = await getIftaWorksheet(client, companyId, quarter);
        const gallons = Object.entries(sheet.gallonsByState)
          .map(([s, g]) => `${s}: ${Math.round(g * 10) / 10} gal`)
          .join(" · ");
        const miles = Object.entries(sheet.milesByState)
          .map(([s, m]) => `${s}: ${m} mi`)
          .join(" · ");
        return [
          `IFTA worksheet ${sheet.quarter}:`,
          `Fuel by state — ${gallons || "none recorded with a state"} (total ${Math.round(sheet.totalGallons * 10) / 10} gal).`,
          `Attributed miles — ${miles || "none yet"}${sheet.unallocatedMiles > 0 ? `; ${sheet.unallocatedMiles} interstate miles can't be honestly split by state yet.` : ""}`,
          sheet.fleetMpg != null
            ? `Odometer miles ${sheet.odometerMiles} → ${sheet.fleetMpg} MPG for the quarter.`
            : "Not enough odometer readings this quarter for an MPG check.",
          ...sheet.anomalies.map((a) => `- ${a}`),
        ].join("\n");
      },
    },
    // GAP-16: per-diem count + tax packet.
    {
      name: "get_tax_packet",
      description:
        "The tax picture for a year: per-diem away days at the labeled IRS transportation rate, fuel totals, expenses by category, and load revenue — assembled for his preparer. Use when he asks about per-diem days, his deduction, or tax time.",
      parameters: {
        type: "object",
        properties: {
          year: { type: "number", description: "Four-digit year. Omit for this year." },
        },
      },
      access: "read",
      validateArgs: validateWith(taxPacketArgs),
      async run(args) {
        const parsed = taxPacketArgs.parse(args);
        const { getTaxPacket } = await import("@/services/tax-filings");
        const { easternDate } = await import("@/lib/day-wrap");
        const year = parsed.year ?? Number(easternDate(new Date()).slice(0, 4));
        const packet = await getTaxPacket(client, companyId, year);
        const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
        const categories = Object.entries(packet.expensesByCategory)
          .map(([k, v]) => `${k} ${dollars(v)}`)
          .join(" · ");
        return [
          `Tax packet ${packet.year}:`,
          `Per-diem: ${packet.perDiem.awayDays} days away from home ≈ ${dollars(packet.perDiem.estimatedDeductionCents)} at ${packet.perDiem.rateLabel}.`,
          `Fuel: ${packet.fuel.purchases} purchases, ${packet.fuel.gallons} gal, ${dollars(packet.fuel.totalCostCents)}.`,
          `Expenses: ${dollars(packet.expensesTotalCents)}${categories ? ` (${categories})` : ""}.`,
          `Loads: ${packet.completedLoads} completed, ${dollars(packet.loadRevenueCents)} booked revenue.`,
          packet.note,
        ].join("\n");
      },
    },
    {
      name: "evaluate_pay_offer",
      description:
        "Grade a pay offer or a load's pay IN CODE (never do pay math yourself - call this). Give the structure (cpm_all_miles, cpm_loaded_only, percentage_gross, percentage_net, flat_per_load, flat_per_day), the quoted numbers, loaded + empty miles, and what you know about days/loads-per-week, W2-vs-1099, and who pays fuel. Returns computed pay for the load, effective CPM on ALL miles, a weekly projection, the W2<->1099 tax adjustment, a strong/fair/weak verdict against the market bands for his seat, and the questions whose answers would change the verdict. If he hasn't given a number the math needs, ASK him for it instead of guessing one into the arguments.",
      parameters: {
        type: "object",
        properties: {
          structure: {
            type: "string",
            enum: ["cpm_all_miles", "cpm_loaded_only", "percentage_gross", "percentage_net", "flat_per_load", "flat_per_day"],
          },
          cpm_dollars: { type: "number", description: "Quoted per-mile rate in dollars (0.60 = 60 cents), for cpm structures." },
          percentage: { type: "number", description: "The driver's percentage cut (0-100), for percentage structures." },
          load_gross_dollars: { type: "number", description: "What the load pays the truck, in dollars." },
          flat_dollars: { type: "number", description: "Flat amount (per load, or per day), for flat structures." },
          loaded_miles: { type: "number" },
          empty_miles: { type: "number", description: "Deadhead/empty miles for the load (0 if none or unknown)." },
          days_on_load: { type: "number" },
          loads_per_week: { type: "number" },
          employment: { type: "string", enum: ["w2", "1099"], description: "Omit if he doesn't know yet." },
          fuel_paid_by: { type: "string", enum: ["owner", "driver", "unknown"] },
          detention_terms_known: { type: "boolean" },
        },
        required: ["structure", "loaded_miles"],
      },
      access: "read",
      async run(args) {
        const parsed = payOfferArgs.parse(args);
        return formatPayEvaluation(evaluatePayOffer(parsed));
      },
    },
    // §13: the Smart Path route check as a read tool — built in its
    // own module (services/bot/route-check-tool.ts) because it wraps
    // the Smart Path engine rather than a table.
    buildRouteCheckTool(store),
    {
      name: "save_memory",
      description:
        "Save to his long-term bot memory, so future conversations on BOTH Telegram and the web chat remember it. Kinds: 'fact'/'note' for dictated facts (standing instructions come through his 'instruction:' messages, not this tool); 'person_profile' when you learn something durable about a PERSON he works with (the truck owner, a dispatcher, a broker, a shipper contact) - content MUST be one line in the format 'PERSON — <Name> | role: <role> | <facts in plain sentences>'; 'business_fact' for how his operation runs (how this carrier pays, a facility's rules, a lane's pattern) - content MUST be 'BUSINESS — <subject> | <fact>'. When a new fact corrects or extends an existing profile, save the profile line whole, updated - one current profile per person, not a pile of fragments. NEVER invent a profile detail: only save what his messages or the forwarded conversations actually show.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["fact", "note", "person_profile", "business_fact"] },
          content: { type: "string", description: "The fact, in one line, in his words where possible." },
        },
        required: ["kind", "content"],
      },
      access: "write",
      validateArgs: validateWith(saveMemoryArgs),
      summarize(args) {
        const parsed = saveMemoryArgs.parse(args);
        return `Memory (${parsed.kind}): "${parsed.content}"`;
      },
      async run(args) {
        const parsed = saveMemoryArgs.parse(args);
        await store.saveMemory(parsed.kind, parsed.content, {
          supersedesId: parsed.supersedes_id,
        });
        return `Saved to memory: "${parsed.content}"`;
      },
    },
    {
      name: "add_load_note",
      description: "Append a note to a load's record. Get the load id from list_loads first if he doesn't give it.",
      parameters: {
        type: "object",
        properties: {
          load_id: { type: "string", description: "The load's id (uuid), from list_loads." },
          note: { type: "string" },
        },
        required: ["load_id", "note"],
      },
      access: "write",
      validateArgs: validateWith(addLoadNoteArgs),
      summarize(args) {
        const parsed = addLoadNoteArgs.parse(args);
        return `Note on load ${parsed.load_id}: "${parsed.note}"`;
      },
      async run(args) {
        const parsed = addLoadNoteArgs.parse(args);
        const { data: load, error: loadError } = await client
          .from("loads")
          .select("id, origin, destination, notes")
          .eq("id", parsed.load_id)
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .maybeSingle();
        if (loadError) throw new Error(loadError.message);
        if (!load) throw new Error(`No load with id ${parsed.load_id} in his records.`);
        const row = load as { origin: string; destination: string; notes: string | null };
        const stamped = `[${new Date().toISOString().slice(0, 10)}] ${parsed.note}`;
        const notes = row.notes ? `${row.notes}\n${stamped}` : stamped;
        const { error } = await client
          .from("loads")
          .update({ notes })
          .eq("id", parsed.load_id)
          .eq("company_id", companyId)
          .is("deleted_at", null);
        if (error) throw new Error(error.message);
        return `Added the note to load ${row.origin} → ${row.destination}.`;
      },
    },
  ];

  // Phase D (pay truth): the pin, settlements, and the weekly
  // report - own module (pay-tools.ts), same registry.
  tools.push(...buildPayTools(store));

  // Phase C (threads + people): forward thread records, open
  // loops, and the evidence-based per-person model - own module
  // (thread-tools.ts), same registry.
  tools.push(...buildThreadTools(store));

  // Phase E (twin): sent-reply capture with code-computed edit
  // distance, the decision log, and honest pattern reads - own
  // module (twin-tools.ts), same registry.
  tools.push(...buildTwinTools(store));

  // Agent omnipresence (§9): full read/write coverage from
  // tools-read.ts / tools-write.ts, then the two meta tools that
  // work over the registry itself - dump staging and proposal
  // revision.
  tools.push(...buildExtendedReadTools(store), ...buildExtendedWriteTools(store));

  const writeRegistry = new Map(
    tools.filter((t) => t.access === "write").map((t) => [t.name, t] as const),
  );

  tools.push({
    name: "stage_dump_items",
    description:
      "Stage EVERYTHING recordable from a dumped message (a forwarded dispatch thread, a pasted rate con or settlement, a brain-dump paragraph) as ONE batch proposal. Extract each record as an item: the write tool that records it, its arguments, a source_quote copied VERBATIM from his message, and your honest confidence. Rules: unknown fields stay OUT (never guess a value, rate, date, or id - ids come from the read tools, called BEFORE staging when an item updates an existing record); every number in an item must appear in his message (code rejects any that doesn't); deletes cannot ride in a dump. Call this ONCE with all items instead of calling the write tools one by one - nothing is recorded until he approves the batch.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Every record extracted from the dump, in the order he should review them.",
          items: {
            type: "object",
            properties: {
              tool_name: { type: "string", description: "The write tool that records this item." },
              args: { type: "object", description: "That tool's arguments, exactly as it defines them." },
              source_quote: { type: "string", description: "The verbatim span of his message this item came from." },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["tool_name", "args", "source_quote", "confidence"],
          },
        },
      },
      required: ["items"],
    },
    access: "write",
    alwaysPropose: true,
    expandProposals: (args, ctx) => validateDumpItems(ctx.userText, args.items, writeRegistry),
    async run() {
      // Unreachable by design: the loop always stages this tool's
      // expanded items as proposals, and stored proposals name the
      // ITEM tools, never this one - so a post-yes execution of the
      // staging call itself can never be legitimate.
      throw new Error("stage_dump_items never executes directly - its items are stored as individual proposals.");
    },
  });

  tools.push({
    name: "revise_pending_item",
    description:
      "Correct ONE item of a pending dump batch after the owner points out a wrong value (e.g. \"3 is wrong, it's 4417\"). patch holds ONLY the fields to change, in the item's own tool argument shape. This edits the stored proposal - nothing is recorded until he approves the batch. Use confirmation \"execute\": the correction is his direct order about the proposal itself.",
    parameters: {
      type: "object",
      properties: {
        item_number: { type: "number", description: "The item's number in the pending batch." },
        patch: { type: "object", description: "Only the fields to change, in the item tool's argument shape." },
      },
      required: ["item_number", "patch"],
    },
    access: "write",
    summarize: (args) =>
      `Correct proposal item ${args.item_number}: ${JSON.stringify(args.patch ?? {})}`,
    async run(args) {
      const itemNumber = typeof args.item_number === "number" ? args.item_number : Number.NaN;
      const patch =
        args.patch && typeof args.patch === "object" ? (args.patch as Record<string, unknown>) : {};
      const batch = await store.loadPendingBatch();
      const item = batch.find((row) => row.item_number === itemNumber);
      if (!item) {
        throw new Error(`There is no pending proposal item numbered ${itemNumber} to correct.`);
      }
      const tool = writeRegistry.get(item.tool_name);
      if (!tool || !tool.validateArgs || !tool.summarize) {
        throw new Error(`Proposal item ${itemNumber} (${item.tool_name}) can't be revised.`);
      }
      const validation = tool.validateArgs({ ...item.arguments, ...patch });
      if (!validation.ok) {
        throw new Error(`That correction doesn't hold up: ${validation.error}. The proposal is unchanged.`);
      }
      const summary = tool.summarize(validation.args);
      await store.updatePendingAction(item.id, validation.args, summary);
      return `Corrected proposal item ${itemNumber}: ${summary}. Still NOT recorded - it takes effect only when he approves it.`;
    },
  });

  // Gaming System (docs/design/gaming-system.md): the Game Plan's
  // conversational surface, in tools-game.ts. Pushed last, after
  // the write registry is built - game writes are direct commands
  // (his own target settings execute immediately, §1.3), never
  // staged inside dump batches.
  tools.push(...buildGameTools(store));

  return tools;
}

const createExpenseArgs = z.object({
  category: z.enum(["insurance", "permits", "repairs", "other"]),
  amount_dollars: z.number().positive(),
  description: z.string().min(1).optional(),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  load_id: z.string().uuid().optional(),
  truck_id: z.string().uuid().optional(),
  driver_id: z.string().uuid().optional(),
});

const createFuelArgs = z.object({
  total_dollars: z.number().positive(),
  gallons: z.number().positive(),
  location: z.string().min(1).optional(),
  // GAP-15: purchase state for the IFTA worksheet, when known.
  state: z.string().length(2).optional(),
  truck_id: z.string().uuid().optional(),
  purchased_at: z.string().min(1).optional(),
  odometer: z.number().int().nonnegative().optional(),
});

const logDutyArgs = z.object({
  duty_status: z.enum(["off_duty", "sleeper", "driving", "on_duty"]),
  location: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  started_at: z.string().min(1).optional(),
  odometer: z.number().int().nonnegative().optional(),
  load_id: z.string().uuid().optional(),
  // Provenance (Image Intelligence §7, migration 00044): code
  // stages 'paper_photo' rows from sheet reads with the sheet's
  // document id; when HE types hours in words - e.g. filling a
  // span a sheet read couldn't resolve - they are his word, so
  // pass source 'conversation'. Ordinary app logging omits both.
  source: z.enum(["app", "paper_photo", "conversation"]).optional(),
  source_document_id: z.string().uuid().optional(),
});

// GAP-04/05 (Fresh-Eyes Register 2026-11-02).
const stampDetentionArgs = z.object({
  load_id: z.string().uuid(),
  stamp_type: z.enum(["arrival", "door", "loading_done", "departure"]),
  stop_kind: z.enum(["pickup", "delivery"]).optional(),
  occurred_at: z.string().min(1).optional(),
});

const iftaArgs = z.object({
  quarter: z
    .string()
    .regex(/^\d{4}Q[1-4]$/, "quarter must look like 2026Q4.")
    .optional(),
});

const taxPacketArgs = z.object({
  year: z.number().int().min(2000).max(2100).optional(),
});

const brokerIdArgs = z.object({
  broker_id: z.string().uuid(),
});

const dayWrapArgs = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD.")
    .optional(),
});

const loadIdArgs = z.object({
  load_id: z.string().uuid(),
});

const saveMemoryArgs = z.object({
  // person_profile / business_fact are the Job Brain (§12) learning
  // kinds - their content MUST use the structured formats from
  // services/bot/people.ts (enforced in the tool description and
  // parsed back by profilesForPerson / parseBusinessFact).
  kind: z.enum(["fact", "note", "person_profile", "business_fact"]),
  content: z.string().min(1),
  // Lane 2 (Phase B): an explicit update names the row it replaces;
  // the store closes that row (valid_to + superseded_by) instead of
  // leaving two contradictory "current" facts. Set by update
  // proposals (e.g. the night shift's staged updates), not by the
  // model freehand.
  supersedes_id: z.string().uuid().optional(),
});

const addLoadNoteArgs = z.object({
  load_id: z.string().uuid(),
  note: z.string().min(1),
});

/**
 * Runs a stored proposal after the owner said yes. The only path by
 * which a bot-proposed write ever executes (§8). Throws on unknown
 * tools or invalid arguments - the caller reports the failure
 * honestly rather than letting a stale proposal half-apply.
 */
export async function executeWriteTool(
  store: BotBrainStore,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = buildBotTools(store).find((t) => t.name === toolName);
  if (!tool || tool.access !== "write") {
    throw new Error(`Unknown write tool "${toolName}".`);
  }
  return tool.run(args);
}
