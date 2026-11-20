// Maintenance bot: speak / stay quiet, code-side parsing, countdowns,
// own-turn triggers, runnable status, and the shared-reasoning wiring.
// Pure logic — no database, no network, no model.
import { describe, expect, it } from "vitest";
import {
  buildWorkOrderDraft,
  checkMaintenanceTurns,
  countdownText,
  decideMaintenanceSpeech,
  formatDueDate,
  handoffToScoutText,
  handleMaintenanceGroupMessage,
  looksLikeCallPlanRequest,
  looksLikeDefectReport,
  looksLikeWorkOrderRequest,
  maintenanceTurnInstructions,
  matchedMaintenanceKeywords,
  parseAbelRoute,
  parseDefectReport,
  parseEstimateCents,
  parseTruckRef,
  postMaintenanceTurns,
  runnableStatusText,
} from "@/services/bots/maintenance";
import { REASONING_FORMS } from "@/services/bots/reasoning";
import { routeGroupMessage } from "@/services/bots/router";
import type { BotTeamStore, ProposalRow } from "@/services/bots/store";

describe("decideMaintenanceSpeech — when Maintenance speaks, when it stays quiet", () => {
  it("speaks in the group when called by name", () => {
    const decision = decideMaintenanceSpeech({ channel: "group", via: "mention", target: "maintenance", abelRouted: false, senderKind: "owner" });
    expect(decision).toEqual({ speak: true, reason: "mention" });
  });

  it("speaks in the group on a reply to its message", () => {
    const decision = decideMaintenanceSpeech({ channel: "group", via: "reply", target: "maintenance", abelRouted: false, senderKind: "owner" });
    expect(decision).toEqual({ speak: true, reason: "reply" });
  });

  it("speaks in the group when Abel routes it", () => {
    const decision = decideMaintenanceSpeech({ channel: "group", via: "keyword", target: "maintenance", abelRouted: true, senderKind: "owner" });
    expect(decision).toEqual({ speak: true, reason: "abel-routed" });
  });

  it("stays quiet on a keyword-only owner message — Abel routes it", () => {
    const decision = decideMaintenanceSpeech({ channel: "group", via: "keyword", target: "maintenance", abelRouted: false, senderKind: "owner" });
    expect(decision).toEqual({ speak: false, reason: "keyword-ambiguous-abel-routes" });
  });

  it("stays quiet on an unrouted message and on another bot's job", () => {
    expect(
      decideMaintenanceSpeech({ channel: "group", via: "default", target: "maintenance", abelRouted: false, senderKind: "owner" }),
    ).toEqual({ speak: false, reason: "not-routed" });
    expect(
      decideMaintenanceSpeech({ channel: "group", via: "mention", target: "dispatch-scout", abelRouted: false, senderKind: "owner" }),
    ).toEqual({ speak: false, reason: "not-my-job" });
  });

  it("answers a bot that explicitly addresses it, never unprompted bot chatter", () => {
    expect(
      decideMaintenanceSpeech({ channel: "group", via: "mention", target: "maintenance", abelRouted: false, senderKind: "bot" }),
    ).toEqual({ speak: true, reason: "mention" });
    expect(
      decideMaintenanceSpeech({ channel: "group", via: "keyword", target: "maintenance", abelRouted: false, senderKind: "bot" }),
    ).toEqual({ speak: false, reason: "bot-unprompted" });
    expect(
      decideMaintenanceSpeech({ channel: "group", via: "default", target: "maintenance", abelRouted: false, senderKind: "bot" }),
    ).toEqual({ speak: false, reason: "bot-unprompted" });
  });

  it("handles its own job directly in its own 1:1 chat, any routing", () => {
    for (const via of ["mention", "reply", "keyword", "default"] as const) {
      const decision = decideMaintenanceSpeech({ channel: "direct", via, target: "maintenance", abelRouted: false, senderKind: "owner" });
      expect(decision).toEqual({ speak: true, reason: "direct-chat" });
    }
  });
});

describe("parseAbelRoute — Abel's handoff is exactly one line", () => {
  it("accepts exactly 'ROUTE: maintenance'", () => {
    expect(parseAbelRoute("ROUTE: maintenance")).toBe("maintenance");
    expect(parseAbelRoute("  route: maintenance  ")).toBe("maintenance");
  });

  it("rejects anything else — a mention is not a route", () => {
    expect(parseAbelRoute("Maintenance can help with that")).toBeNull();
    expect(parseAbelRoute("ROUTE: maintenance\nHere is the plan")).toBeNull();
    expect(parseAbelRoute("ROUTE: dispatch-scout")).toBeNull();
    expect(parseAbelRoute(null)).toBeNull();
    expect(parseAbelRoute("")).toBeNull();
  });
});

describe("maintenance keyword matching", () => {
  it("matches the job words and names them", () => {
    expect(matchedMaintenanceKeywords("my tire is flat")).toContain("tire");
    expect(matchedMaintenanceKeywords("file a DVIR for the defect")).toEqual(expect.arrayContaining(["dvir", "defect"]));
    expect(matchedMaintenanceKeywords("when is the DOT annual inspection due?")).toEqual(
      expect.arrayContaining(["dot", "inspection", "annual inspection"]),
    );
  });

  it("matches nothing on a load message", () => {
    expect(matchedMaintenanceKeywords("find me a load to Dallas")).toEqual([]);
  });
});

describe("code-side parsing — figures come from the owner's words, never invented", () => {
  it("parses a defect, truck, and urgency from a report", () => {
    const report = parseDefectReport("Maintenance, my tire is flat on truck 2");
    expect(report?.defect).toBe("flat tire");
    expect(report?.truckRef).toBe("2");
    expect(report?.urgency).toBe("as-reported-urgent");
    expect(report?.flags).toEqual([]);
  });

  it("flags a missing truck instead of guessing one", () => {
    const report = parseDefectReport("the brakes are soft");
    expect(report?.defect).toBe("brake problem");
    expect(report?.truckRef).toBeNull();
    expect(report?.flags).toHaveLength(1);
  });

  it("returns null when no defect is reported", () => {
    expect(parseDefectReport("when is my DOT inspection due?")).toBeNull();
  });

  it("tells a report from a question", () => {
    expect(looksLikeDefectReport("my tire is flat on truck 2")).toBe(true);
    expect(looksLikeDefectReport("is a flat tire a DVIR defect?")).toBe(false);
  });

  it("parses truck refs and dollar estimates in code", () => {
    expect(parseTruckRef("unit 7 needs an oil change")).toBe("7");
    expect(parseTruckRef("what is due?")).toBeNull();
    expect(parseEstimateCents("the shop quoted $450.50")).toBe(45050);
    expect(parseEstimateCents("the shop quoted 450")).toBeNull();
  });

  it("recognises work-order, estimate, and call-plan asks", () => {
    expect(looksLikeWorkOrderRequest("draft a work order for the brakes")).toBe(true);
    expect(looksLikeWorkOrderRequest("get an estimate from the shop")).toBe(true);
    expect(looksLikeWorkOrderRequest("when is my inspection due?")).toBe(false);
    expect(looksLikeCallPlanRequest("call the shop about the estimate")).toBe(true);
    expect(looksLikeCallPlanRequest("draft a work order")).toBe(false);
  });

  it("builds a work-order draft with flags for everything missing — never guessed", () => {
    const draft = buildWorkOrderDraft("draft a work order for the brake problem, estimate $450");
    expect(draft.problem).toBe("brake problem");
    expect(draft.estimateCents).toBe(45000);
    expect(draft.truckRef).toBeNull();
    expect(draft.shopName).toBeNull();
    expect(draft.flags.join(" ")).toMatch(/truck not named/);
    expect(draft.flags.join(" ")).toMatch(/shop not named/);
  });

  it("never invents an estimate", () => {
    const draft = buildWorkOrderDraft("draft a work order for the brakes");
    expect(draft.estimateCents).toBeNull();
    expect(draft.flags.join(" ")).toMatch(/estimate unknown/);
  });
});

describe("countdowns — computed in code, never in the model's head", () => {
  const NOW = new Date("2026-11-19T12:00:00Z").getTime();

  it("formats a due date without a weekday", () => {
    expect(formatDueDate("2026-03-15")).toBe("Mar 15, 2026");
    expect(formatDueDate("not-a-date")).toBe("not-a-date");
  });

  it("counts days down to a DOT inspection and miles down to a PM", () => {
    expect(countdownText({ label: "DOT inspection", dueDate: "2026-12-01", nowMs: NOW })).toMatch(/due in 12 days \(Dec 1, 2026\)/);
    expect(countdownText({ label: "Oil change", dueMiles: 100000, currentMiles: 98500, nowMs: NOW })).toMatch(/due in 1,500 miles/);
  });

  it("says overdue plainly, by days and by miles", () => {
    expect(countdownText({ label: "DOT inspection", dueDate: "2026-11-10", nowMs: NOW })).toMatch(/OVERDUE by 9 days/);
    expect(countdownText({ label: "Oil change", dueMiles: 90000, currentMiles: 91000, nowMs: NOW })).toMatch(/OVERDUE by 1,000 miles/);
  });

  it("admits when nothing is on file", () => {
    expect(countdownText({ label: "DOT inspection", nowMs: NOW })).toMatch(/no due date or mileage on file/);
  });
});

describe("own-turn triggers — PM due, DVIR open, work order ready", () => {
  const NOW = new Date("2026-11-19T12:00:00Z").getTime();

  it("fires a PM reminder inside 7 days or 500 miles, or overdue", () => {
    const turns = checkMaintenanceTurns({
      nowMs: NOW,
      pmItems: [
        { label: "DOT inspection", dueDate: "2026-11-24" },
        { label: "Oil change", dueMiles: 100000, currentMiles: 99800 },
        { label: "Air filter", dueDate: "2027-06-01" },
      ],
      openDefects: [],
      workOrdersReady: [],
    });
    expect(turns.map((t) => t.trigger)).toEqual(["pm-due", "pm-due"]);
    expect(turns[0]?.text).toMatch(/PM reminder/);
  });

  it("follows up a defect open longer than 24 hours, not a fresh one", () => {
    const turns = checkMaintenanceTurns({
      nowMs: NOW,
      pmItems: [],
      openDefects: [
        { defect: "flat tire", truckRef: "2", reportedAtMs: NOW - 25 * 60 * 60 * 1000 },
        { defect: "light out", truckRef: null, reportedAtMs: NOW - 60 * 60 * 1000 },
      ],
      workOrdersReady: [],
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.trigger).toBe("dvir-open");
    expect(turns[0]?.text).toMatch(/still open/);
    expect(turns[0]?.text).toMatch(/repaired yet/);
  });

  it("never re-posts a ready work order — it was announced when drafted", () => {
    const turns = checkMaintenanceTurns({
      nowMs: NOW,
      pmItems: [],
      openDefects: [],
      workOrdersReady: [{ title: "Work order draft — brake problem" }],
    });
    expect(turns).toEqual([]);
  });
});

describe("runnable status for Dispatch Scout", () => {
  it("names runnable trucks and tells Scout not to offer loads to a down truck", () => {
    const text = runnableStatusText([
      { ref: "1", down: false },
      { ref: "2", down: true, reason: "flat tire, open DVIR defect" },
    ]);
    expect(text).toMatch(/Runnable: 1/);
    expect(text).toMatch(/Down: truck 2 — flat tire, open DVIR defect/);
    expect(text).toMatch(/Do not offer loads to this truck/);
  });

  it("admits when no truck status is on file", () => {
    expect(runnableStatusText([])).toMatch(/no truck status on file/i);
  });

  it("hands a down truck straight to Scout, reported state only", () => {
    // Line 1 is the addressed handoff machine line (validated state
    // only); line 2 is the human line the room already knows.
    expect(handoffToScoutText("flat tire", "2")).toBe(
      "Dispatch Scout — handoff: job=progress about=truck-down truck=2 defect=flat-tire hops=0\n" +
        "Dispatch Scout — truck 2 reported down (flat tire). Do not offer loads to this truck until the defect clears.",
    );
  });
});

describe("Maintenance turn instructions — same reasoning as Abel, own job/tools/memory", () => {
  it("carries the identity, the scope, and every shared reasoning form", () => {
    const instructions = maintenanceTurnInstructions([{ kind: "fact", content: "DOT inspection due Mar 15, 2026." }]);
    const kinds = instructions.map((row) => row.kind);
    expect(kinds).toContain("identity");
    expect(kinds).toContain("scope");
    expect(instructions.filter((row) => row.kind === "reasoning")).toHaveLength(REASONING_FORMS.length);
    for (const form of REASONING_FORMS) {
      expect(instructions.some((row) => row.kind === "reasoning" && row.content.includes(`REASONING — ${form.name}:`))).toBe(true);
    }
    expect(instructions.some((row) => row.content.includes("DOT inspection due Mar 15, 2026."))).toBe(true);
  });
});

describe("postMaintenanceTurns — due turns post once, combined; nothing due posts nothing", () => {
  function makeStore(proposals: ProposalRow[]): BotTeamStore {
    return {
      companyId: "company-1",
      createProposal: async () => {
        throw new Error("not used");
      },
      listOpenProposals: async (limit = 20) => proposals.slice(0, limit),
      getProposal: async () => null,
      decideProposal: async () => {
        throw new Error("not used");
      },
      logAudit: async () => {},
      recordLoadOutcome: async () => {},
      ensureGroupRoom: async () => {},
      recordGroupMessage: async () => {},
      reserveSpend: async () => "reservation",
      settleSpend: async () => {},
      loadBotMemories: async () => [],
      saveBotMemory: async (input) => ({ id: "memory-new", bot_slug: input.botSlug, kind: input.kind, content: input.content, source: input.source ?? "bot", created_at: new Date().toISOString() }),
      listComplianceDeadlines: async () => [],
      upsertComplianceDeadline: async () => { throw new Error("not used"); },
      listOpenDefects: async () => [],
      listRecentDutySegments: async () => [],
      hasRecentAlert: async () => false,
      listRecentAudit: async () => [],
      hasRecentAuditFingerprint: async () => false,
      listHandoffsFor: async () => [],
      listRecentGroupMessages: async () => [],
      recordCheckCall: async () => { throw new Error("not used"); },
      listCheckCalls: async () => [],
      startDetentionClock: async () => { throw new Error("not used"); },
      getOpenDetentionClock: async () => null,
      endDetentionClock: async () => { throw new Error("not used"); },
      getDocPacket: async () => null,
      setDocPacket: async () => { throw new Error("not used"); },
      getGroupMessageSender: async () => null,
      recordHandoff: async () => { throw new Error("not used"); },
      listOpenHandoffs: async () => [],
      claimHandoff: async () => { throw new Error("not used"); },
      completeHandoff: async () => { throw new Error("not used"); },
      hasAuditorCheck: async () => false,
      findGroupMessage: async () => null,
      claimJob: async () => true,
      releaseJob: async () => {},
    };
  }

  const NOW = new Date("2026-11-19T12:00:00Z").getTime();

  it("posts a follow-up for a defect open over 24 hours", async () => {
    const proposal: ProposalRow = {
      id: "p1",
      company_id: "company-1",
      bot_slug: "maintenance",
      kind: "record-draft",
      title: "DVIR defect — flat tire (truck 2)",
      payload: { recordKind: "dvir-defect", defect: "flat tire", truckRef: "2" },
      source_ref: null,
      status: "proposed",
      created_at: new Date(NOW - 26 * 60 * 60 * 1000).toISOString(),
      decided_at: null,
      decided_by: null,
    };
    const sent: string[] = [];
    const result = await postMaintenanceTurns({
      chatId: -100,
      store: makeStore([proposal]),
      sendMessage: async (_chatId, text) => {
        sent.push(text);
        return [1];
      },
      nowMs: NOW,
    });
    expect(result.posted).toBe(true);
    expect(result.turns.map((t) => t.trigger)).toEqual(["dvir-open"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/DVIR follow-up/);
  });

  it("posts nothing when nothing is due", async () => {
    const sent: string[] = [];
    const result = await postMaintenanceTurns({
      chatId: -100,
      store: makeStore([]),
      sendMessage: async (_chatId, text) => {
        sent.push(text);
        return [1];
      },
      nowMs: NOW,
      pmItems: [{ label: "Air filter", dueDate: "2027-06-01" }],
    });
    expect(result).toEqual({ posted: false, turns: [] });
    expect(sent).toEqual([]);
  });
});

describe("individual faces — the label follows the token, not the text", () => {
  async function runTurn(speakAsSelf: boolean): Promise<string[]> {
    const sent: string[] = [];
    const route = routeGroupMessage({ text: "Maintenance, what is due next?", senderKind: "owner" });
    await handleMaintenanceGroupMessage({
      text: "Maintenance, what is due next?",
      route,
      channel: "group",
      deps: {
        chatId: -100,
        store: {
          companyId: "company-1",
          createProposal: async () => { throw new Error("not used"); },
          listOpenProposals: async () => [],
          getProposal: async () => null,
          decideProposal: async () => { throw new Error("not used"); },
          logAudit: async () => {},
          recordLoadOutcome: async () => {},
          ensureGroupRoom: async () => {},
          recordGroupMessage: async () => {},
          reserveSpend: async () => "reservation",
          settleSpend: async () => {},
          loadBotMemories: async () => [],
          saveBotMemory: async (input) => ({ id: "memory-new", bot_slug: input.botSlug, kind: input.kind, content: input.content, source: input.source ?? "bot", created_at: new Date().toISOString() }),
          claimJob: async () => true,
          releaseJob: async () => {},
          listComplianceDeadlines: async () => [],
          upsertComplianceDeadline: async () => { throw new Error("not used"); },
          listOpenDefects: async () => [],
          listRecentDutySegments: async () => [],
          hasRecentAlert: async () => false,
          listRecentAudit: async () => [],
          hasRecentAuditFingerprint: async () => false,
          listHandoffsFor: async () => [],
          listRecentGroupMessages: async () => [],
          recordCheckCall: async () => { throw new Error("not used"); },
          listCheckCalls: async () => [],
          startDetentionClock: async () => { throw new Error("not used"); },
          getOpenDetentionClock: async () => null,
          endDetentionClock: async () => { throw new Error("not used"); },
          getDocPacket: async () => null,
          setDocPacket: async () => { throw new Error("not used"); },
          getGroupMessageSender: async () => null,
          recordHandoff: async () => { throw new Error("not used"); },
          listOpenHandoffs: async () => [],
          claimHandoff: async () => { throw new Error("not used"); },
          completeHandoff: async () => { throw new Error("not used"); },
          hasAuditorCheck: async () => false,
          findGroupMessage: async () => null,
        },
        sendMessage: async (_chatId, text) => {
          sent.push(text);
          return [1];
        },
        runChat: async () => "Oil change is due in 2,000 miles.",
        speakAsSelf,
      },
    });
    return sent;
  }

  it("labels with 'Maintenance: ' on the shared-token fallback", async () => {
    expect(await runTurn(false)).toEqual(["Maintenance: Oil change is due in 2,000 miles."]);
  });

  it("posts unlabeled from its own account — Telegram shows its name and photo", async () => {
    expect(await runTurn(true)).toEqual(["Oil change is due in 2,000 miles."]);
  });
});
