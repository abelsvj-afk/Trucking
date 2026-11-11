// Abel's read path to the active load (active-load navigation, point 1): the SAME state the Home map reads through
// GET /api/v1/active-load - the current load, its next stop, and the route summary (distance + ETA) from the truck's last known
// position. Read-only. It never states a route that was not computed, and a car-profile route is stamped NOT truck-legal.

import type { AgentTool } from "@/services/ai/agent-loop";
import { buildActiveLoadState, describeActiveLoadState, type ActiveLoadDeps } from "@/services/navigation/active-load-state";
import type { BotBrainStore } from "./store";

export function buildNavigationTools(store: BotBrainStore, deps: ActiveLoadDeps = {}): AgentTool[] {
  return [
    {
      name: "active_load_status",
      description:
        "The load he is on RIGHT NOW, its next stop, and the route to that stop from the truck's last known position: miles, drive time and ETA (Eastern), and which routing engine served it. Use for 'where am I going', 'how far to the next stop', 'what's my ETA', 'what load am I on'. The ETA is straight driving time with no breaks counted - compare it with his hours using hos_summary / delivery_feasibility before saying he will make it. If the route is marked NOT truck-legal, say so in those words and do not give turn directions from it. If there is no route, say the reason given; never estimate miles or an ETA yourself.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        try {
          return describeActiveLoadState(await buildActiveLoadState(store.client, store.companyId, deps));
        } catch {
          return "The active load couldn't be read right now. Say that plainly; don't guess the load, the stop or an ETA.";
        }
      },
    },
  ];
}
