// The shared team pieces every bot uses (owner 2026-11-21): roster, understanding, least-privilege reads,
// honest replies, names.
import { describe, expect, it } from "vitest";
import type { AgentTool } from "@/services/ai/agent-loop";
import { BOT_SLUGS } from "@/services/bots/registry";
import { isEmptyPromise, parseUnderstanding, readToolsFor, rosterText, runTeamTurn, stripOwnName, TEAM_ROSTER, toolGroupOf } from "@/services/bots/team-turn";

const read = (name: string): AgentTool => ({ name, description: "", parameters: {}, access: "read", run: async () => "ok" }) as AgentTool;

describe("team roster", () => {
  it("every bot in the registry — including ones not built yet — is on the roster with a name and a job; Malik is listed", () => {
    expect(TEAM_ROSTER.map((r) => r.slug)).toEqual([...BOT_SLUGS]);
    for (const r of TEAM_ROSTER) {
      expect(r.name).toBeTruthy();
      expect(r.job.length).toBeGreaterThan(10);
    }
    expect(rosterText()).toContain("Malik");
    expect(rosterText()).toMatch(/Dispatch Scout \(dispatch-scout; also called scout, dispatch/);
  });
});

describe("understanding", () => {
  it("accepts JSON wrapped in prose or a code fence; rejects an unknown bot or junk", () => {
    expect(parseUnderstanding('Sure:\n```json\n{"to":"dispatch-scout","ask":"loads from Oklahoma to Florida"}\n```')).toEqual({ to: "dispatch-scout", ask: "loads from Oklahoma to Florida", smallTalk: false });
    expect(parseUnderstanding('{"to":"santa","ask":"x"}')).toBeNull();
    expect(parseUnderstanding("no idea")).toBeNull();
  });
});

describe("least privilege", () => {
  it("Abel gets every read; Scout gets only what his scope opens (money/loads read, never calls)", () => {
    const all = [read("list_loads"), read("money_summary"), read("list_outbound_calls"), read("hos_summary")];
    expect(readToolsFor("abel", all).map((t) => t.name)).toEqual(["list_loads", "money_summary", "list_outbound_calls", "hos_summary"]);
    // Tracker's scope has money: none
    expect(readToolsFor("tracker", all).map((t) => t.name)).not.toContain("money_summary");
    expect(toolGroupOf("list_outbound_calls")).toBe("calls");
    expect(toolGroupOf("list_loads")).toBe("loads");
  });
});

describe("honest, human replies", () => {
  it("an 'I'll check … let you know' with nothing started is caught; the same line after a tool is fine", () => {
    expect(isEmptyPromise("I'll check for loads and let you know.", 0, 0)).toBe(true);
    expect(isEmptyPromise("I'll check for loads and let you know.", 1, 0)).toBe(false);
    expect(isEmptyPromise("Malik's the phone voice.", 0, 0)).toBe(false);
  });

  it("a bot never opens with its own name (the chat already shows it)", () => {
    expect(stripOwnName("dispatch-scout", "Dispatch Scout: on it")).toBe("on it");
    expect(stripOwnName("dispatch-scout", "Scout: on it")).toBe("on it");
    expect(stripOwnName("abel", "Abel: morning!")).toBe("morning!");
  });

  it("runTeamTurn gives a not-yet-built bot (Maintenance) its own name, the team style and hand_off", async () => {
    let system = "";
    let toolNames: string[] = [];
    const provider = {
      complete: async () => "",
      runToolTurn: async (messages: { role: string; content: unknown }[], tools: { name: string }[]) => {
        system = String(messages.find((m) => m.role === "system")?.content ?? "");
        toolNames = tools.map((t) => t.name);
        return { text: "Maintenance here — what's going on with the truck?", toolCalls: [] };
      },
    };
    const out = await runTeamTurn({ slug: "maintenance", provider: provider as never, text: "truk making a noise", history: [], readTools: [] });
    expect(system).toContain("You are Maintenance");
    expect(system).toMatch(/Never tell him how to phrase things/);
    expect(toolNames).toContain("hand_off");
    expect(out.reply).toBe("Maintenance here — what's going on with the truck?");
  });
});
