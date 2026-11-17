// Abel's side of Smart Path v2 (docs/design/smart-path-v2.md): "plan my run", "will I make it", "when do I get
// there" - answered by the SAME automatic planner as the page (active load, live position, next stop,
// appointments, his clocks), so chat and page can't disagree. Read-only; nothing is stored.

import type { AgentTool } from "@/services/ai/agent-loop";
import { runAutoSmartPath } from "@/services/smart-path/auto";
import { hoursLine, keyFacts, timeline } from "@/lib/smart-path-summary";
import { HOME_TIME_ZONE } from "@/lib/display-zone";
import type { BotBrainStore } from "./store";

const WORD: Record<string, string> = { on_time: "ON TIME", early: "EARLY", late: "LATE", not_legal: "NOT LEGAL AS PLANNED" };

export function buildPlanRunTools(store: BotBrainStore): AgentTool[] {
  return [
    {
      name: "plan_my_run",
      description:
        "Smart Path for his CURRENT situation with nothing to ask: plans the active load (or load_id) from where the truck is right now, knowing whether the pickup is already done, the stops' appointments and his hours. Use for 'plan my run', 'will I make it', 'when do I get there', 'where do I sleep / fuel'. For a what-if with specific times or windows use check_route.",
      parameters: {
        type: "object",
        properties: {
          load_id: { type: "string", description: "Only if he names a different load (uuid from list_loads)." },
          depart_at: { type: "string", description: "ISO time he plans to leave, if not now." },
        },
      },
      access: "read",
      async run(args) {
        const out = await runAutoSmartPath(store.client, store.companyId, {
          loadId: typeof args.load_id === "string" ? args.load_id : null,
          departAt: typeof args.depart_at === "string" ? args.depart_at : null,
        });
        if (!out.result) return [out.load ? `Load: ${out.load.label}` : "", ...out.assumptions].filter(Boolean).join("\n");
        const r = out.result;
        return [
          `Load: ${out.load?.label ?? `${r.load.origin} → ${r.load.destination}`}`,
          `Verdict: ${WORD[r.verdict.status] ?? r.verdict.status}${r.verdict.tradeoffLines[0] ? ` - ${r.verdict.tradeoffLines[0]}` : ""}`,
          `Assumed: ${out.assumptions.join(" ")}`,
          hoursLine(r)?.text ?? "",
          hoursLine(r)?.fromAppLog && hoursLine(r)?.tight
            ? "If his carrier's ELD shows more hours than this app's log, the verdict is wrong - tell him, and that he can enter his ELD hours under Smart Path -> Change."
            : "",
          ...keyFacts(r, HOME_TIME_ZONE).map((f) => `${f.label}: ${f.value}${f.sub ? ` (${f.sub})` : ""}`),
          "The run:",
          ...timeline(r, HOME_TIME_ZONE).map((t) => `- ${t.text}`),
          r.route.truckLegal ? "" : "Route is a CAR route (not truck-checked) - say so.",
          "Planning only - paper-log helper, not an ELD. Full detail is on the Smart Path page.",
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
  ];
}
