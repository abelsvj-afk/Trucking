// Abel Intelligence Upgrade, Phase E (design §6/§7). The twin's
// tools: capture what he actually sent (edit distance computed in
// code), read the pattern back honestly, and keep the decision log
// that "what do I usually do?" answers from. Everything here is
// gated on the driver_twin capability in the DISPATCH path
// (exemplar injection); the tools themselves also respect it for
// capture: with the twin off, record_sent_reply refuses plainly -
// off means off (design Phase E acceptance 3).

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { validateWith } from "./tool-helpers";

const TWIN_OFF_NOTE =
  "The driver twin is OFF (Settings → Driver twin), so I'm not capturing sent replies or tracking draft edits. Turn it on and I'll start learning from what you actually send.";

export function buildTwinTools(store: BotBrainStore): AgentTool[] {
  return [
    {
      name: "list_recent_exchanges",
      description:
        "Recent dispatch exchanges (id, when, what came in, whether Abel drafted a reply, whether his actual sent reply is captured, and the draft edit distance when measured). Use it to find the exchange a sent reply belongs to before calling record_sent_reply.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Default 10, max 25." } },
      },
      access: "read",
      async run(args) {
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(25, Math.floor(args.limit))) : 10;
        const exchanges = await store.listRecentExchanges(limit);
        if (exchanges.length === 0) return "No dispatch exchanges recorded yet.";
        return exchanges
          .map(
            (ex) =>
              `- [${ex.id}] ${ex.createdAt.slice(0, 10)}: "${ex.incoming.slice(0, 120)}" — draft: ${ex.hasDraft ? "yes" : "no"}, his sent reply: ${
                ex.actualReplySent ? `captured${ex.editDistanceRatio != null ? ` (he changed ~${Math.round(ex.editDistanceRatio * 100)}% of the draft)` : ""}` : "not captured"
              }`,
          )
          .join("\n");
      },
    },
    {
      name: "record_sent_reply",
      description:
        "Capture what he ACTUALLY sent in reply to a dispatch message (he pastes it, forwards the thread showing it, or tells you). This is the twin's food: the sent text joins the voice corpus, and code measures how far it sits from Abel's draft (edit distance) - the number that proves whether drafts are learning his voice. Needs the exchange id (list_recent_exchanges). With the driver twin OFF this refuses: off stops capture and tracking entirely.",
      parameters: {
        type: "object",
        properties: {
          exchange_id: { type: "string" },
          actual_reply: { type: "string", description: "Exactly what he sent - verbatim, his words." },
        },
        required: ["exchange_id", "actual_reply"],
      },
      access: "write",
      validateArgs: validateWith(
        z.object({ exchange_id: z.string().uuid(), actual_reply: z.string().min(1) }),
      ),
      summarize(args) {
        return `Capture his sent reply for exchange ${String(args.exchange_id ?? "")} (twin corpus + edit-distance measurement)`;
      },
      async run(args) {
        if (!(await store.isDriverTwinEnabled())) return TWIN_OFF_NOTE;
        const { editDistanceRatio } = await store.recordSentReply(
          String(args.exchange_id),
          String(args.actual_reply),
        );
        return editDistanceRatio != null
          ? `Captured. His sent reply sits ${Math.round(editDistanceRatio * 100)}% of the draft's words away from what I suggested - that measurement is stored with the exchange and feeds the weekly twin line.`
          : "Captured - that exchange had no Abel draft to measure against, so no edit distance; the reply still joins the voice corpus for future drafts.";
      },
    },
    {
      name: "record_load_decision",
      description:
        "Log one of HIS load decisions in the decision log: a load he took or passed, in his words, plus the outcome when known. Only log decisions he actually made (he says so, or a thread shows it) - never infer a decision from silence. Fill in the structured fields (states, miles, pay, deadhead, the driver, and his reason) whenever he gives them: that is what lets his preferences be LEARNED from the log. This log is what 'what do I usually do when a broker lowballs?' answers from, with counts.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "The load/offer in his words (\"Memphis load, $1,900, 700 mi, broker X\")." },
          decision: { type: "string", enum: ["taken", "passed"] },
          load_id: { type: "string", description: "The recorded load's id, when it is one." },
          outcome_note: { type: "string", description: "What happened after, when known." },
          driver_id: { type: "string", description: "The driver this decision was for (uuid from list_drivers), when it was not the owner himself." },
          origin_state: { type: "string", description: "Two-letter pickup state, when known." },
          destination_state: { type: "string", description: "Two-letter delivery state, when known." },
          miles: { type: "number", description: "Loaded miles, when known." },
          rate_dollars: { type: "number", description: "What the load pays in total, in dollars, when known." },
          deadhead_miles: { type: "number", description: "Empty miles to the pickup, when known." },
          reason: { type: "string", description: "WHY, in his words (\"too far from home\", \"rate too low\"), when he says." },
        },
        required: ["description", "decision"],
      },
      access: "write",
      validateArgs: validateWith(
        z.object({
          description: z.string().min(1),
          decision: z.enum(["taken", "passed"]),
          load_id: z.string().uuid().optional(),
          outcome_note: z.string().min(1).optional(),
          driver_id: z.string().uuid().optional(),
          origin_state: z.string().length(2).optional(),
          destination_state: z.string().length(2).optional(),
          miles: z.number().int().nonnegative().optional(),
          rate_dollars: z.number().nonnegative().optional(),
          deadhead_miles: z.number().int().nonnegative().optional(),
          reason: z.string().min(1).optional(),
        }),
      ),
      summarize(args) {
        return `Decision log: ${String(args.decision ?? "")} — ${String(args.description ?? "")}`;
      },
      async run(args) {
        await store.recordLoadDecision({
          loadId: (args.load_id as string | undefined) ?? null,
          description: String(args.description),
          decision: args.decision as "taken" | "passed",
          outcomeNote: (args.outcome_note as string | undefined) ?? null,
          driverId: (args.driver_id as string | undefined) ?? null,
          originState: typeof args.origin_state === "string" ? args.origin_state.toUpperCase() : null,
          destinationState: typeof args.destination_state === "string" ? args.destination_state.toUpperCase() : null,
          miles: typeof args.miles === "number" ? args.miles : null,
          rateCents: typeof args.rate_dollars === "number" ? Math.round(args.rate_dollars * 100) : null,
          deadheadMiles: typeof args.deadhead_miles === "number" ? args.deadhead_miles : null,
          reason: (args.reason as string | undefined) ?? null,
        });
        return `Logged: he ${args.decision === "taken" ? "took" : "passed on"} "${String(args.description)}". The decision log is what pattern questions read - with counts, never vibes.`;
      },
    },
    {
      name: "decision_patterns",
      description:
        "His logged load decisions as patterns WITH COUNTS (taken vs passed, recent entries, outcomes noted). When the log is thin, this says there isn't enough history yet - quote that honestly instead of inventing a pattern. This is the only honest source for 'what do I usually do?' questions.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const decisions = await store.listLoadDecisions(100);
        if (decisions.length < 3) {
          return `Not enough history yet: the decision log holds ${decisions.length} entr${decisions.length === 1 ? "y" : "ies"} - patterns need a handful of logged decisions before they mean anything. Log them as they happen (record_load_decision) and this gets real.`;
        }
        const taken = decisions.filter((d) => d.decision === "taken");
        const passed = decisions.filter((d) => d.decision === "passed");
        const lines = [
          `Decision log: ${decisions.length} decisions - ${taken.length} taken, ${passed.length} passed.`,
          "Most recent:",
          ...decisions.slice(0, 8).map(
            (d) => `- ${d.createdAt.slice(0, 10)} ${d.decision.toUpperCase()}: ${d.description}${d.outcomeNote ? ` — outcome: ${d.outcomeNote}` : ""}`,
          ),
        ];
        return lines.join("\n");
      },
    },
    {
      name: "twin_status",
      description:
        "The driver twin's state, honestly: switch on or off, how many of his sent replies the corpus holds, and the recent draft-edit average. Call this when he asks whether the twin is on, or how much he changes your drafts.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const enabled = await store.isDriverTwinEnabled();
        const exchanges = await store.listRecentExchanges(100);
        const captured = exchanges.filter((e) => e.actualReplySent);
        const measured = captured.filter((e) => e.editDistanceRatio != null);
        const lines = [
          enabled
            ? "Driver twin: ON - Telegram dispatch drafts use his real sent replies as examples, and sent-reply capture measures draft edits. (Web dispatch drafts don't use the twin yet.)"
            : "Driver twin: OFF - no exemplar injection, no edit tracking. (Settings → Driver twin turns it on.)",
          `Voice corpus: ${captured.length} captured sent repl${captured.length === 1 ? "y" : "ies"} in the recent exchange window.`,
        ];
        if (measured.length > 0) {
          const avg = measured.reduce((t, e) => t + (e.editDistanceRatio ?? 0), 0) / measured.length;
          lines.push(
            `Across the ${measured.length} measured exchange(s) in that window, he changes about ${Math.round(avg * 100)}% of the draft's words before sending.`,
          );
        } else if (captured.length > 0) {
          lines.push("No draft-vs-sent measurements yet (the captured replies had no Abel draft to compare against).");
        }
        return lines.join("\n");
      },
    },
  ];
}
