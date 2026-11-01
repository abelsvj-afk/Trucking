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
import { pickRelevantMemories } from "@/services/telegram/context";
import type { BotBrainStore } from "./store";
import type { DutyLog } from "@/types/entities";
import { validateWith } from "./tool-helpers";
import { buildExtendedReadTools } from "./tools-read";
import { buildGameTools } from "./tools-game";
import { buildExtendedWriteTools } from "./tools-write";
import { validateDumpItems } from "./dump-intake";
import { evaluatePayOffer, formatPayEvaluation, payOfferArgs } from "./pay-advisor";
import { buildRouteCheckTool } from "./route-check-tool";

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
      name: "search_memories",
      description: "Search his long-term bot memories (facts, notes, expense hints he dictated) by topic. Use when he refers to something he told you before that isn't in the remembered-facts block.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      access: "read",
      async run(args) {
        const memories = await store.loadMemories();
        const hits = pickRelevantMemories(memories, String(args.query ?? ""), 10);
        if (hits.length === 0) return "No memories matched that.";
        return hits.map((m) => `- (${m.kind}, ${m.created_at.slice(0, 10)}) ${m.content}`).join("\n");
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
      description: "Record a fuel purchase in his books. Needs the total paid and gallons; pass truck_id when he names the truck (from list_trucks) - otherwise, if he has exactly one truck on file, that truck is used.",
      parameters: {
        type: "object",
        properties: {
          total_dollars: { type: "number", description: "Total paid at the pump, in dollars." },
          gallons: { type: "number" },
          location: { type: "string", description: "Station / city, if he said." },
          truck_id: { type: "string", description: "Truck id (uuid), if he named the truck." },
          purchased_at: { type: "string", description: "ISO timestamp of the purchase. Defaults to now." },
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
        const { data, error } = await client
          .from("fuel_purchases")
          .insert({
            company_id: companyId,
            truck_id: truck.id,
            location: parsed.location ?? null,
            gallons: parsed.gallons,
            price_per_gallon_cents: Math.round(totalCents / parsed.gallons),
            total_cost_cents: totalCents,
            purchased_at: parsed.purchased_at ?? new Date().toISOString(),
          })
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        return `Recorded fuel purchase ${dollars(totalCents)} for ${parsed.gallons} gal on truck ${truck.unit_number}. Record id ${(data as { id: string }).id}.`;
      },
    },
    {
      name: "log_duty_status",
      description: "Log a duty-status change in his paper-log helper (NOT the ELD - the helper never replaces the legal record): off_duty, sleeper, driving, or on_duty. Starts now unless he names a start time.",
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
        const { error } = await client.from("duty_logs").insert({
          company_id: companyId,
          duty_status: parsed.duty_status,
          started_at: parsed.started_at ?? new Date().toISOString(),
          location: parsed.location ?? null,
          notes: parsed.notes ?? null,
          odometer: parsed.odometer ?? null,
          load_id: parsed.load_id ?? null,
        });
        if (error) throw new Error(error.message);
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
            : "")
        );
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
        await store.saveMemory(parsed.kind, parsed.content);
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
  truck_id: z.string().uuid().optional(),
  purchased_at: z.string().min(1).optional(),
});

const logDutyArgs = z.object({
  duty_status: z.enum(["off_duty", "sleeper", "driving", "on_duty"]),
  location: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  started_at: z.string().min(1).optional(),
  odometer: z.number().int().nonnegative().optional(),
  load_id: z.string().uuid().optional(),
});

const saveMemoryArgs = z.object({
  // person_profile / business_fact are the Job Brain (§12) learning
  // kinds - their content MUST use the structured formats from
  // services/bot/people.ts (enforced in the tool description and
  // parsed back by profilesForPerson / parseBusinessFact).
  kind: z.enum(["fact", "note", "person_profile", "business_fact"]),
  content: z.string().min(1),
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
