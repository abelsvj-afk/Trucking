// Dynamic tool selection (owner requirement, 2026-11-09): Abel "can have thousands of tools,
// it just needs to know which ones it needs in this moment." These tests pin the contract:
// - the router's per-turn selection is intent-ranked and stays under the provider cap even
//   when the WRITE tools alone outgrow it;
// - the catalog search finds a tool by what it DOES (description words), not only its name;
// - a turn whose first selection LACKS a needed tool still completes by pulling it mid-turn
//   (find_more_tools), and a model that names a real-but-unoffered tool gets it loaded rather
//   than an error - a routing absence never becomes "I can't do that";
// - the spec cap holds while pulling (uncalled reads are evicted, never a called tool);
// - a pulled WRITE still only stages a proposal (propose -> yes is untouched);
// - the catalog's shape bounds the pull (a read-only catalog can never surface a write).

import { describe, expect, it, vi } from "vitest";
import { FIND_MORE_TOOLS_NAME, runAgentLoop, type AgentTool } from "@/services/ai/agent-loop";
import type { AiAgentMessage, AiToolSpec, AiToolTurnResult, AgentCapableProvider } from "@/services/ai/provider";
import { searchToolCatalog, selectToolsForTurn } from "@/services/bot/tool-budget";

const readTool = (name: string, description: string, run?: () => Promise<string>): AgentTool => ({
  name,
  description,
  parameters: { type: "object", properties: {} },
  access: "read",
  run: run ?? (async () => `${name} result`),
});

const writeTool = (name: string, description: string, run: (args: Record<string, unknown>) => Promise<string>): AgentTool => ({
  name,
  description,
  parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  access: "write",
  summarize: (args) => `${name}: ${String(args.note ?? "")}`,
  run,
});

/** Scripted provider whose each step is a function of the specs/messages it was actually offered. */
function harness(steps: ((ctx: { tools: AiToolSpec[]; messages: AiAgentMessage[] }) => AiToolTurnResult)[]) {
  let index = 0;
  const seenSpecs: AiToolSpec[][] = [];
  const provider: AgentCapableProvider = {
    complete: async () => {
      throw new Error("complete() is not used by the agent loop");
    },
    runToolTurn: async (messages, tools) => {
      seenSpecs.push(tools);
      const step = steps[Math.min(index, steps.length - 1)]!;
      index += 1;
      return step({ tools, messages });
    },
  };
  return { provider, seenSpecs };
}

const call = (id: string, name: string, args: Record<string, unknown>): AiToolTurnResult => ({
  text: null,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});
const say = (text: string): AiToolTurnResult => ({ text, toolCalls: [] });
const names = (tools: AiToolSpec[]) => tools.map((t) => t.name);

const baseInput = { system: "test", contextText: "", history: [] as never[], userText: "help me with the load" };

describe("searchToolCatalog", () => {
  const catalog = [
    readTool("fuel_summary", "Fuel spend totals by week."),
    readTool("route_weather", "Forecast and storm alerts along a route's corridor."),
    readTool("load_stops_detail", "The pickup and delivery stops recorded for a load, in order."),
  ];

  it("finds a tool by what it does, from description words alone", () => {
    expect(searchToolCatalog(catalog, "storm alerts corridor").map((t) => t.name)).toEqual(["route_weather"]);
    expect(searchToolCatalog(catalog, "stops recorded in order").map((t) => t.name)).toContain("load_stops_detail");
  });

  it("ranks a name match above a description-only match and respects the limit", () => {
    const many = [
      readTool("weekly_digest", "A summary that mentions fuel once."),
      readTool("fuel_summary", "Totals."),
      readTool("fuel_by_station", "Totals."),
    ];
    const found = searchToolCatalog(many, "fuel", 2);
    expect(found).toHaveLength(2);
    expect(found[0]!.name).toBe("fuel_summary");
  });

  it("returns nothing when nothing matches", () => {
    expect(searchToolCatalog(catalog, "zanzibar quux")).toEqual([]);
  });
});

describe("selectToolsForTurn at registry scale", () => {
  it("stays under budget and intent-ranked even when the writes alone outgrow the budget", () => {
    const writes = Array.from({ length: 150 }, (_, i) =>
      writeTool(`write_action_${i}`, `Records thing number ${i}.`, async () => "ok"),
    );
    const reads = Array.from({ length: 40 }, (_, i) => readTool(`read_thing_${i}`, `Reads thing number ${i}.`));
    const registry = [...writes, ...reads];
    const picked = selectToolsForTurn(registry, "record thing number 42 please", 120);
    expect(picked.length).toBeLessThanOrEqual(120);
    expect(picked.map((t) => t.name)).toContain("write_action_42");
    // Deterministic: same input, same selection.
    expect(selectToolsForTurn(registry, "record thing number 42 please", 120).map((t) => t.name)).toEqual(
      picked.map((t) => t.name),
    );
  });
});

describe("the pull-more path inside a turn", () => {
  it("DEMONSTRATION: a turn whose first selection lacks the needed tool completes by pulling it", async () => {
    const stopsRun = vi.fn(async () => "Stops for Trip 1874: 1) PICKUP Kontoor, Panama City, FL. 2) DELIVERY Kontoor, Seminole, OK.");
    const stopsTool = readTool("load_stops_detail", "The pickup and delivery stops recorded for a load, in order.", stopsRun);
    const fillers = [
      readTool("fuel_summary", "Fuel spend totals by week."),
      readTool("money_summary", "Expense totals and balances."),
      readTool("driver_profile", "The driver's profile and preferences."),
    ];
    const catalog = [...fillers, stopsTool];
    const selection = fillers; // the router's first pick: the stops tool is NOT in it

    const { provider, seenSpecs } = harness([
      ({ tools }) => {
        expect(names(tools)).toContain(FIND_MORE_TOOLS_NAME);
        expect(names(tools)).not.toContain("load_stops_detail");
        return call("s1", FIND_MORE_TOOLS_NAME, { query: "stops recorded for a load pickup delivery" });
      },
      ({ tools }) => {
        expect(names(tools)).toContain("load_stops_detail");
        return call("s2", "load_stops_detail", {});
      },
      () => say("Trip 1874 stops: Panama City pickup, then Seminole delivery."),
    ]);

    const out = await runAgentLoop({
      ...baseInput,
      provider,
      userText: "what are the stops on Trip 1874",
      tools: selection,
      toolCatalog: catalog,
      toolSpecLimit: 120,
    });

    expect(stopsRun).toHaveBeenCalledTimes(1);
    expect(out.reply).toBe("Trip 1874 stops: Panama City pickup, then Seminole delivery.");
    expect(out.ranOutOfSteps).toBe(false);
    expect(out.toolLog.map((e) => e.tool)).toEqual([FIND_MORE_TOOLS_NAME, "load_stops_detail"]);
    for (const specs of seenSpecs) expect(specs.length).toBeLessThanOrEqual(120);
  });

  it("a model that names a real-but-unoffered tool gets it loaded, not an 'I can't'", async () => {
    const run = vi.fn(async () => "trailer H11887 is on file");
    const trailerTool = readTool("trailer_detail", "One trailer's record by unit number.", run);
    const selection = [readTool("fuel_summary", "Fuel spend totals by week.")];
    const { provider } = harness([
      () => call("s1", "trailer_detail", {}),
      ({ tools }) => {
        expect(names(tools)).toContain("trailer_detail");
        return call("s2", "trailer_detail", {});
      },
      () => say("Trailer H11887 is on file."),
    ]);

    const out = await runAgentLoop({
      ...baseInput,
      provider,
      tools: selection,
      toolCatalog: [...selection, trailerTool],
      toolSpecLimit: 120,
    });

    expect(run).toHaveBeenCalledTimes(1); // only the second call executed; the first just loaded it
    expect(out.reply).toBe("Trailer H11887 is on file.");
  });

  it("the spec cap holds while pulling: uncalled reads are evicted, a called tool never is", async () => {
    const reads = ["r1", "r2", "r3", "r4", "r5"].map((n) => readTool(n, `Plain read ${n}.`));
    const hidden = ["h1", "h2", "h3", "h4"].map((n) => readTool(n, `Zebra capability ${n}.`));
    const { provider, seenSpecs } = harness([
      () => call("s1", "r1", {}),
      () => call("s2", FIND_MORE_TOOLS_NAME, { query: "zebra" }),
      ({ tools }) => {
        expect(names(tools)).toContain("r1"); // called this turn - protected
        expect(names(tools)).toContain("h2");
        expect(names(tools)).not.toContain("r5"); // tail uncalled read - evicted to make room
        return call("s3", "h2", {});
      },
      () => say("Done."),
    ]);

    const out = await runAgentLoop({
      ...baseInput,
      provider,
      tools: reads,
      toolCatalog: [...reads, ...hidden],
      toolSpecLimit: 6, // finder + 5 reads already fill it
    });

    expect(out.reply).toBe("Done.");
    for (const specs of seenSpecs) expect(specs.length).toBeLessThanOrEqual(6);
  });

  it("a pulled WRITE still only stages a proposal - propose -> yes is untouched", async () => {
    const run = vi.fn(async () => "archived");
    const archive = writeTool("archive_load", "Archive a load that is finished and settled.", run);
    const selection = [readTool("fuel_summary", "Fuel spend totals by week.")];
    const { provider } = harness([
      () => call("s1", FIND_MORE_TOOLS_NAME, { query: "archive a load" }),
      ({ tools }) => {
        expect(names(tools)).toContain("archive_load");
        return call("s2", "archive_load", { note: "Trip 1874", confirmation: "propose" });
      },
      () => say("I staged that as a proposal - it records only if you say yes."),
    ]);

    const out = await runAgentLoop({
      ...baseInput,
      provider,
      tools: selection,
      toolCatalog: [...selection, archive],
      toolSpecLimit: 120,
    });

    expect(run).not.toHaveBeenCalled();
    expect(out.proposals.map((p) => p.tool)).toEqual(["archive_load"]);
  });

  it("a read-only catalog can never surface a write, however the search is worded", async () => {
    // create_expense exists in the app, but this turn's catalog is the read-only pool:
    // the pull searches ONLY the catalog, so the write can never be loaded into the turn.
    const readsOnlyCatalog = [
      readTool("fuel_summary", "Fuel spend totals by week."),
      readTool("money_summary", "Expense totals and balances."),
      readTool("driver_profile", "The driver's profile and preferences."),
    ];
    let finderResult = "";
    const { provider, seenSpecs } = harness([
      () => call("s1", FIND_MORE_TOOLS_NAME, { query: "record an expense" }),
      ({ messages }) => {
        finderResult = messages.filter((m) => m.role === "tool").at(-1)?.content ?? "";
        return say("Nothing to record there.");
      },
    ]);

    const out = await runAgentLoop({
      ...baseInput,
      provider,
      tools: readsOnlyCatalog.slice(0, 1),
      toolCatalog: readsOnlyCatalog,
      toolSpecLimit: 120,
    });

    expect(out.reply).toBe("Nothing to record there.");
    for (const specs of seenSpecs) expect(names(specs)).not.toContain("create_expense");
    // The search DID run against the read-only catalog - it loaded the matching read, never the write.
    expect(finderResult).toContain("money_summary");
    expect(finderResult).not.toContain("create_expense");
  });
});
