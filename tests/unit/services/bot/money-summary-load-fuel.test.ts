import { describe, expect, it } from "vitest";
import { buildBotTools } from "@/services/bot/tools";
import { createBotStore } from "@/services/bot/store";
import { recordingClient } from "../../../helpers/recording-client";

// Unit D follow-up: Abel's per-load money answer includes only the fuel the owner ASSIGNED to the load
// (fuel_purchases.load_id), scoped to the company - and no longer claims fuel can't be tied to loads.
const A = "00000000-0000-0000-0000-00000000aaaa";
const LOAD = "11111111-1111-4111-8111-111111111111";

describe("money_summary with a load_id", () => {
  it("asks for the fuel assigned to that load, scoped to the company, and says unassigned fuel is in no load's figures", async () => {
    const { client, queries } = recordingClient();
    const store = createBotStore(client as never, A, "telegram");
    const tool = buildBotTools(store).find((t) => t.name === "money_summary")!;
    const text = await tool.run({ load_id: LOAD });
    const fuelByLoad = queries.find((q) => q.table === "fuel_purchases" && q.filters.load_id === LOAD);
    expect(fuelByLoad?.filters.company_id).toBe(A);
    expect(text).toContain("Fuel he assigned to this load");
    expect(text).toContain("Fuel he did not assign to a load is in no load's figures");
    expect(text).not.toContain("not linked to individual loads");
  });
});
