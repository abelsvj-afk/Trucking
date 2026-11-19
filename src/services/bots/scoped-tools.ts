// Scoped tool catalogs — the gateway that keeps one shared brain
// from leaking another bot's tools (owner rule 2026-11-19).
//
// Abel's registry (services/bot/tools.ts, buildBotTools) is the
// full set: 160 tools (159 at the audit, plus list_malik_call_reports from PR #98). A group turn never offers the full set.
// It offers a filtered catalog, per bot:
//
//   1. READ tools only. No Abel write tool is ever offered in a
//      group turn — a bot's writes happen only through the propose
//      tools below, which stage a bot_proposals row and wait for
//      the owner's yes (guardrails.ts). A bot that cannot see a
//      write cannot stage one by accident.
//   2. Only the tool groups the bot's registry scope allows
//      (services/bots/registry.ts), from its governing file.
//   3. Only tools classified here. A tool with no entry is
//      invisible — fail closed — and the completeness test
//      (scoped-tools.test.ts) fails the build until a new Abel
//      tool is classified. A new capability never leaks into a
//      bot's turn by default.
//
// The agent loop's find_more_tools searches the SAME filtered
// catalog (toolCatalog), so a pull can never surface a tool the
// turn refused — the loop's own contract says the catalog must
// be passed "in the same gated/filtered shape as the selection".
//
// Classification values:
//   a ToolGroup — the read tool belongs to that group.
//   "shared"   — a no-data helper (date math) every bot may use.
//   "abel-only" — Abel's personal machinery (his memories, twin,
//      threads, research engines, news, game plan, way home,
//      learning report, capability gaps, business credit, calls).
//      Never offered to a group bot, whatever its scope says.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import { buildBotTools } from "@/services/bot/tools";
import type { BotBrainStore } from "@/services/bot/store";
import { visibleToolGroups, type BotSlug, type ToolGroup } from "./registry";
import type { ProposalKind } from "./store";

export type ToolClassification = ToolGroup | "shared" | "abel-only";

/**
 * Which group each READ tool in Abel's registry belongs to.
 * Keyed by tool name; a read tool with no entry here is invisible
 * to every bot (fail closed). Write tools are not listed: the
 * catalog filter drops every write before classification matters.
 */
export const READ_TOOL_GROUPS: Record<string, ToolClassification> = {
  // loads — the operating picture: loads, trucks, drivers, brokers, plans.
  list_loads: "loads",
  list_trucks: "loads",
  get_truck: "loads",
  list_trailers: "loads",
  list_drivers: "loads",
  list_contacts: "loads",
  search_dispatch_exchanges: "loads",
  get_load_paperwork: "loads",
  get_day_wrap: "loads",
  get_broker_scorecard: "loads",
  plan_my_run: "loads",
  timeline: "loads",
  whats_due: "loads",
  load_calendar: "loads",
  driver_profile: "loads",
  learn_driver_patterns: "loads",
  recommend_loads: "loads",
  home_time_status: "loads",
  fleet_overview: "loads",
  lane_rate_history: "loads",
  delivery_feasibility: "loads",
  evaluate_plan: "loads",
  quick_reference: "loads",
  active_load_status: "loads",
  // hos — duty logs and the hours picture.
  hos_summary: "hos",
  list_duty_logs: "hos",
  // money — pay, settlements, expenses, tax.
  money_summary: "money",
  get_receivables: "money",
  get_cash_calendar: "money",
  get_ifta_worksheet: "money",
  get_tax_packet: "money",
  evaluate_pay_offer: "money",
  list_expenses: "money",
  list_fuel_purchases: "money",
  paychecks_by_payday: "money",
  get_pay_status: "money",
  extract_settlement: "money",
  weekly_pay_report: "money",
  explain_load_pay: "money",
  projected_pay: "money",
  monthly_income: "money",
  // documents — files, inspections, maintenance records.
  list_documents: "documents",
  get_document: "documents",
  search_documents: "documents",
  get_credential_watch: "documents",
  list_inspections: "documents",
  list_checklist_items: "documents",
  list_maintenance_events: "documents",
  list_maintenance_schedules: "documents",
  maintenance_outlook: "documents",
  // email — the company inbox, read-only in a group turn.
  email_inbox: "email",
  read_email_verbatim: "email",
  // maps — places and route checks.
  list_facilities: "maps",
  check_route: "maps",
  // shared — no-data helpers, every bot may use them.
  when_is: "shared",
  time_between: "shared",
  // abel-only — Abel's personal machinery, never a group bot's.
  search_memory: "abel-only",
  list_memories: "abel-only",
  search_memories: "abel-only",
  list_industry_briefings: "abel-only",
  list_research_briefings: "abel-only",
  get_research_briefing: "abel-only",
  list_research_requests: "abel-only",
  list_agent_lessons: "abel-only",
  get_game_plan: "abel-only",
  way_home: "abel-only",
  learning_report: "abel-only",
  list_outbound_calls: "abel-only",
  list_malik_call_reports: "abel-only",
  news_digest: "abel-only",
  list_watch_topics: "abel-only",
  get_knowledge: "abel-only",
  list_learning_topics: "abel-only",
  list_business_credit_accounts: "abel-only",
  list_open_threads: "abel-only",
  get_thread: "abel-only",
  build_person_model: "abel-only",
  list_recent_exchanges: "abel-only",
  decision_patterns: "abel-only",
  twin_status: "abel-only",
  note_capability_gap: "abel-only",
};

/** The classification of one tool, or null when unclassified (invisible). */
export function toolGroupOf(toolName: string): ToolClassification | null {
  return READ_TOOL_GROUPS[toolName] ?? null;
}

/**
 * The read-only catalog one bot may see in a turn: Abel's registry
 * filtered to reads, classified, and inside the bot's registry
 * scope. The returned list IS the loop's catalog too, so
 * find_more_tools can only surface tools from this same set.
 */
export function scopedToolCatalog(brainStore: BotBrainStore, slug: BotSlug): AgentTool[] {
  const visible = new Set<ToolGroup>(visibleToolGroups(slug));
  return buildBotTools(brainStore).filter((tool) => {
    if (tool.access !== "read") return false;
    const group = READ_TOOL_GROUPS[tool.name];
    if (!group || group === "abel-only") return false;
    if (group === "shared") return true;
    return visible.has(group);
  });
}

// ---------------------------------------------------------------------------
// Propose tools — a group bot's only writes. Each one stages a
// bot_proposals row (via the turn, services/bots/turn.ts) and waits
// for the owner's yes. They are alwaysPropose: even a direct order
// from the owner inside the turn cannot execute one in the loop —
// the loop stages it and the turn persists it as a proposal.
// Their run() is a backstop only: it never writes anything, and
// only runs if some future path executes a staged proposal
// directly (no such path exists in this phase).
// ---------------------------------------------------------------------------

export const PROPOSE_TOOL_KINDS: Record<string, ProposalKind> = {
  propose_load_draft: "load-draft",
  propose_shortlist: "load-shortlist",
  propose_message: "message-draft",
  propose_status_update: "record-draft",
  propose_work_order: "record-draft",
  propose_invoice: "record-draft",
};

const STAGED_NOTE =
  "Staged as a proposal — recorded in the team's proposal list, waiting for the owner's yes. Nothing was executed.";

function moneyOf(args: Record<string, unknown>, key: string): string {
  const cents = typeof args[key] === "number" ? args[key] : null;
  return cents === null ? "no pay given" : `$${(cents / 100).toFixed(2)}`;
}

const loadDraftSchema = z.object({
  pay_cents: z.number().int().nonnegative().nullable().optional(),
  loaded_miles: z.number().nonnegative().nullable().optional(),
  deadhead_miles: z.number().nonnegative().nullable().optional(),
  rate_cents_per_loaded_mile: z.number().int().nonnegative().nullable().optional(),
  claimed_per_loaded_mile_cents: z.number().nullable().optional(),
  claimed_per_all_miles_cents: z.number().nullable().optional(),
  origin: z.string().max(200).nullable().optional(),
  destination: z.string().max(200).nullable().optional(),
  broker: z.string().max(200).nullable().optional(),
  pickup_window_start: z.string().nullable().optional(),
  pickup_window_end: z.string().nullable().optional(),
  delivery_window_start: z.string().nullable().optional(),
  delivery_window_end: z.string().nullable().optional(),
});

const shortlistLoadSchema = loadDraftSchema.extend({
  origin: z.string().max(200),
  destination: z.string().max(200),
});

function validateWith<T extends z.ZodTypeAny>(
  schema: T,
): (args: Record<string, unknown>) => { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  return (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    }
    return { ok: true, args: parsed.data as Record<string, unknown> };
  };
}

function proposeTool(def: {
  name: keyof typeof PROPOSE_TOOL_KINDS;
  description: string;
  parameters: Record<string, unknown>;
  validate: (args: Record<string, unknown>) => { ok: true; args: Record<string, unknown> } | { ok: false; error: string };
  summarize: (args: Record<string, unknown>) => string;
}): AgentTool {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    access: "write",
    alwaysPropose: true,
    validateArgs: def.validate,
    summarize: def.summarize,
    run: async () => STAGED_NOTE,
  };
}

/**
 * The propose tools one bot may call in a turn, by its job.
 * Auditor and Compliance Watchdog have none: they flag by
 * replying in the group — a flag is their answer, not a record.
 * Abel gets only propose_message in the group: load work belongs
 * to Dispatch Scout, and Abel routes it there instead of
 * drafting it himself.
 */
export function botProposeTools(slug: BotSlug): AgentTool[] {
  const tools: AgentTool[] = [];
  if (slug === "dispatch-scout") {
    tools.push(
      proposeTool({
        name: "propose_load_draft",
        description:
          "Propose ONE load draft from a forwarded dispatch or a load you worked up: pay, miles, broker, windows. " +
          "The draft is checked against the source by the Auditor's recomputation in code before it is shown. " +
          "It is a proposal — nothing is recorded until the owner replies YES.",
        parameters: {
          type: "object",
          properties: {
            pay_cents: { type: "number", description: "Total pay quoted, in cents. Leave out when not quoted." },
            loaded_miles: { type: "number", description: "Loaded miles." },
            deadhead_miles: { type: "number", description: "Deadhead miles to the pickup." },
            rate_cents_per_loaded_mile: { type: "number", description: "Broker's rate in cents per loaded mile." },
            origin: { type: "string", description: "Pickup city/state." },
            destination: { type: "string", description: "Delivery city/state." },
            broker: { type: "string", description: "Broker name." },
            pickup_window_start: { type: "string", description: "Pickup window start, ISO." },
            pickup_window_end: { type: "string", description: "Pickup window end, ISO." },
            delivery_window_start: { type: "string", description: "Delivery window start, ISO." },
            delivery_window_end: { type: "string", description: "Delivery window end, ISO." },
          },
        },
        validate: validateWith(loadDraftSchema),
        summarize: (args) =>
          `Load draft — ${moneyOf(args, "pay_cents")}${typeof args.loaded_miles === "number" ? `, ${args.loaded_miles} mi` : ""}${
            typeof args.broker === "string" && args.broker ? `, broker ${args.broker}` : ""
          }`,
      }),
      proposeTool({
        name: "propose_shortlist",
        description:
          "Propose a shortlist of 1 to 5 loads you scanned and priced: each with pay, loaded + deadhead miles, origin, destination, and broker. " +
          "Every load is checked by the Auditor's recomputation in code before it is shown. " +
          "It is a proposal — nothing is recorded until the owner replies YES.",
        parameters: {
          type: "object",
          properties: {
            loads: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: {
                type: "object",
                properties: {
                  pay_cents: { type: "number" },
                  loaded_miles: { type: "number" },
                  deadhead_miles: { type: "number" },
                  rate_cents_per_loaded_mile: { type: "number" },
                  origin: { type: "string" },
                  destination: { type: "string" },
                  broker: { type: "string" },
                },
                required: ["origin", "destination"],
              },
            },
          },
          required: ["loads"],
        },
        validate: validateWith(z.object({ loads: z.array(shortlistLoadSchema).min(1).max(5) })),
        summarize: (args) => {
          const loads = Array.isArray(args.loads) ? args.loads : [];
          return `Shortlist — ${loads.length} load${loads.length === 1 ? "" : "s"} priced for the round trip`;
        },
      }),
    );
  }
  if (slug === "tracker") {
    tools.push(
      proposeTool({
        name: "propose_status_update",
        description:
          "Propose a load status update (picked up, en route, delivered, delayed) with an ETA. " +
          "It is a proposal — nothing is recorded until the owner replies YES.",
        parameters: {
          type: "object",
          properties: {
            load_id: { type: "string", description: "The load's id from list_loads, when known." },
            status: { type: "string", description: "The new status, in plain words." },
            eta: { type: "string", description: "ETA, ISO or plain words." },
            note: { type: "string", description: "One line of context." },
          },
          required: ["status"],
        },
        validate: validateWith(
          z.object({
            load_id: z.string().nullable().optional(),
            status: z.string().min(1).max(200),
            eta: z.string().max(200).nullable().optional(),
            note: z.string().max(500).nullable().optional(),
          }),
        ),
        summarize: (args) => `Status update — ${String(args.status ?? "")}${typeof args.eta === "string" && args.eta ? `, ETA ${args.eta}` : ""}`,
      }),
    );
  }
  if (slug === "maintenance") {
    tools.push(
      proposeTool({
        name: "propose_work_order",
        description:
          "Propose a work-order draft for a repair or service: the truck, what is wrong, and any estimate. " +
          "It is a proposal — the owner approves the shop and the estimate; you never authorise a repair. " +
          "Nothing is recorded until the owner replies YES.",
        parameters: {
          type: "object",
          properties: {
            truck: { type: "string", description: "Which truck, in plain words." },
            title: { type: "string", description: "Short title for the work." },
            description: { type: "string", description: "What is wrong and what is needed." },
            estimate_cents: { type: "number", description: "Estimate in cents, when a shop gave one." },
          },
          required: ["title"],
        },
        validate: validateWith(
          z.object({
            truck: z.string().max(200).nullable().optional(),
            title: z.string().min(1).max(200),
            description: z.string().max(1000).nullable().optional(),
            estimate_cents: z.number().int().nonnegative().nullable().optional(),
          }),
        ),
        summarize: (args) => `Work order — ${String(args.title ?? "")}${typeof args.truck === "string" && args.truck ? ` (${args.truck})` : ""}`,
      }),
    );
  }
  if (slug === "billing") {
    tools.push(
      proposeTool({
        name: "propose_invoice",
        description:
          "Propose an invoice draft for a delivered load: amount, broker, and the load it belongs to. " +
          "It is a proposal — sending it needs the owner's approval, and you never move money. " +
          "Nothing is recorded until the owner replies YES.",
        parameters: {
          type: "object",
          properties: {
            load_id: { type: "string", description: "The load's id from list_loads, when known." },
            amount_cents: { type: "number", description: "Invoice amount in cents." },
            broker: { type: "string", description: "Broker name." },
            due: { type: "string", description: "Due date or terms, in plain words." },
          },
          required: ["amount_cents"],
        },
        validate: validateWith(
          z.object({
            load_id: z.string().nullable().optional(),
            amount_cents: z.number().int().positive(),
            broker: z.string().max(200).nullable().optional(),
            due: z.string().max(200).nullable().optional(),
          }),
        ),
        summarize: (args) => `Invoice draft — ${moneyOf(args, "amount_cents")}${typeof args.broker === "string" && args.broker ? `, broker ${args.broker}` : ""}`,
      }),
    );
  }
  if (slug === "abel" || slug === "dispatch-scout" || slug === "tracker" || slug === "maintenance" || slug === "billing") {
    tools.push(
      proposeTool({
        name: "propose_message",
        description:
          "Propose a message draft to someone outside the app (a broker, shipper, receiver, or shop): who it goes to and the exact text. " +
          "It is a proposal — nothing is sent until the owner replies YES.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "Who the message goes to, in plain words." },
            body: { type: "string", description: "The exact message text." },
          },
          required: ["to", "body"],
        },
        validate: validateWith(z.object({ to: z.string().min(1).max(200), body: z.string().min(1).max(2000) })),
        summarize: (args) => `Message draft to ${String(args.to ?? "")}`,
      }),
    );
  }
  return tools;
}
