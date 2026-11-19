// Bot-team group mode: fail-closed allowlist, owner-only room, routing,
// proposal yes/no in plain words, spend cap in front of the model.
import { describe, expect, it, vi } from "vitest";
import { handleBotTeamGroupUpdate, type GroupHandlerDeps } from "@/services/bots/group";
import type { BotTeamStore, ProposalRow } from "@/services/bots/store";
import type { TelegramUpdate } from "@/services/telegram/dispatch-bot";
import { sendTelegramMessage } from "@/services/telegram/bot-api";
import { SPEND_CAP_REACHED_TEXT } from "@/services/bots/spend";

// The per-bot send path is mocked: the Maintenance as-self test proves
// the token routing without touching the network.
vi.mock("@/services/telegram/bot-api", () => ({
  sendTelegramMessage: vi.fn(async () => [99]),
}));

const OWNER_ID = 8975172276;
const GROUP_ID = -1001234567890;

function makeUpdate(
  text: string,
  fromId: number = OWNER_ID,
  isBot = false,
  messageId = 10,
  extra?: { username?: string; replyTo?: { username?: string; text?: string } },
): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: messageId,
      from: { id: fromId, is_bot: isBot, username: extra?.username },
      chat: { id: GROUP_ID, type: "supergroup" },
      text,
      reply_to_message: extra?.replyTo
        ? { from: { username: extra.replyTo.username }, text: extra.replyTo.text }
        : undefined,
    },
  };
}

interface StubState {
  proposals: ProposalRow[];
  spentCents: number;
  audit: { action: string; targetRef: string | null }[];
  groupMessages: { text: string }[];
  memories?: { content: string }[];
  ledger?: { loadRef: string; outcome: string; notes: string | null }[];
  /** Job claims: key -> expires-at ms. Optional: makeStub defaults it. */
  claims?: Map<string, number>;
}

function makeStub(state: StubState): BotTeamStore {
  let seq = 0;
  const claims = (state.claims ??= new Map<string, number>());
  return {
    companyId: "company-1",
    createProposal: async (input) => {
      const row: ProposalRow = {
        id: `proposal-${++seq}`,
        company_id: "company-1",
        bot_slug: input.botSlug,
        kind: input.kind,
        title: input.title,
        payload: input.payload,
        source_ref: input.sourceRef ?? null,
        status: "proposed",
        created_at: new Date().toISOString(),
        decided_at: null,
        decided_by: null,
      };
      state.proposals.push(row);
      return row;
    },
    listOpenProposals: async (limit = 20) => state.proposals.filter((p) => p.status === "proposed").slice(0, limit),
    getProposal: async (id) => state.proposals.find((p) => p.id === id) ?? null,
    decideProposal: async (id, decision, decidedBy) => {
      const row = state.proposals.find((p) => p.id === id);
      if (!row) throw new Error(`proposal ${id} not found`);
      if (row.status !== "proposed") return row;
      row.status = decision;
      row.decided_at = new Date().toISOString();
      row.decided_by = decidedBy;
      return row;
    },
    logAudit: async (input) => {
      state.audit.push({ action: input.action, targetRef: input.targetRef ?? null });
    },
    recordLoadOutcome: async (input) => {
      if (state.ledger) state.ledger.push({ loadRef: input.loadRef, outcome: input.outcome, notes: input.notes ?? null });
    },
    ensureGroupRoom: async () => {},
    recordGroupMessage: async (input) => {
      state.groupMessages.push({ text: input.text });
    },
    recordSpend: async (input) => {
      state.spentCents += input.estimatedCents;
    },
    spentThisMonthCents: async () => state.spentCents,
    loadBotMemories: async () =>
      (state.memories ?? []).map((memory, index) => ({
        id: `memory-${index + 1}`,
        bot_slug: "dispatch-scout",
        kind: "preference",
        source: "test",
        content: memory.content,
        created_at: new Date().toISOString(),
      })),
    claimJob: async (jobKey, _botSlug, ttlMs = 5 * 60 * 1000) => {
      const now = Date.now();
      const expires = claims.get(jobKey);
      if (expires !== undefined && expires > now) return false;
      claims.set(jobKey, now + ttlMs);
      return true;
    },
    releaseJob: async (jobKey) => {
      claims.delete(jobKey);
    },
  };
}

function makeDeps(state: StubState, overrides: Partial<GroupHandlerDeps> = {}): { deps: GroupHandlerDeps; sent: string[] } {
  const sent: string[] = [];
  const deps: GroupHandlerDeps = {
    botToken: "token",
    allowedChatId: String(OWNER_ID),
    groupChatId: String(GROUP_ID),
    companyId: "company-1",
    store: makeStub(state),
    sendMessage: async (_chatId, text) => {
      sent.push(text);
      return [1];
    },
    runChat: async () => "Hi — I'm Abel.",
    ...overrides,
  };
  return { deps, sent };
}

describe("bot-team group mode", () => {
  it("ignores groups when no group chat id is configured", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state, { groupChatId: null });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello"), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("ignores a group that is not the allowlisted room", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state, { groupChatId: "-999" });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello"), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("ignores anyone who is not the owner — the room has no third parties", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello", 12345), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("ignores bot senders — bots do not answer each other unprompted", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("noted", OWNER_ID, true), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("answers the owner through Abel with the bot's name first", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps)).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Abel: Hi/);
    expect(state.groupMessages.length).toBeGreaterThan(0);
  });

  it("tells the owner plainly when the model key is not configured", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state, { runChat: undefined });
    await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps);
    expect(sent[0]).toMatch(/AI key isn't configured/);
  });

  it("refuses the model call when the spend cap is hit, and says so", async () => {
    const state: StubState = { proposals: [], spentCents: 1000, audit: [], groupMessages: [], claims: new Map() };
    const runChat = vi.fn(async () => "should not run");
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps);
    expect(runChat).not.toHaveBeenCalled();
    expect(sent[0]).toContain(SPEND_CAP_REACHED_TEXT.slice(0, 40));
  });

  it("answers a board question from Dispatch Scout honestly — no board is live yet", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("find me a load"), deps);
    expect(sent[0]).toMatch(/can't scan boards yet/);
  });

  it("works a forwarded dispatch into an auditor-checked proposal", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(
      makeUpdate("New load: pickup Dallas, delivery Houston, pay $1850, 240 miles, broker FastFreight"),
      deps,
    );
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe("load-draft");
    expect(sent[0]).toMatch(/Dispatch Scout/);
    expect(sent[0]).toMatch(/Reply Yes to approve/);
  });

  it("resolves 'yes' to the newest open proposal and audits the decision", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(
      makeUpdate("New load: pickup Dallas, delivery Houston, pay $1850, 240 miles"),
      deps,
    );
    await handleBotTeamGroupUpdate(makeUpdate("yes"), deps);
    expect(state.proposals[0]!.status).toBe("approved");
    expect(sent[sent.length - 1]).toMatch(/^Approved:/);
    expect(state.audit.some((a) => a.action === "proposal_approved")).toBe(true);
  });

  it("says plainly when nothing is waiting on a yes or no", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("yes"), deps);
    expect(sent[0]).toMatch(/Nothing is waiting/);
  });

  it("tells the owner a seat is not in the room yet instead of pretending it is", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("Auditor, check this"), deps);
    expect(sent[0]).toMatch(/isn't in the room yet/);
  });

  it("asks where the truck is when a scan names no origin", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state, {
      browserRuntime: {
        route: "shared-vm",
        readBoard: async () => ({ boardSlug: "trulos", status: "ok", loads: [], note: "ok", readAtIso: new Date().toISOString() }),
        watchUrl: () => "https://browser.example/watch/run-1",
        stopRun: async () => ({ stopped: true, reason: "Stopped." }),
      },
    });
    await handleBotTeamGroupUpdate(makeUpdate("scout, scan"), deps);
    expect(sent[0]).toMatch(/where's the truck right now/);
  });

  it("asks for the missing cost numbers instead of inventing them", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state, {
      browserRuntime: {
        route: "shared-vm",
        readBoard: async () => ({ boardSlug: "trulos", status: "ok", loads: [], note: "ok", readAtIso: new Date().toISOString() }),
        watchUrl: () => "https://browser.example/watch/run-1",
        stopRun: async () => ({ stopped: true, reason: "Stopped." }),
      },
    });
    await handleBotTeamGroupUpdate(makeUpdate("scout, scan from Panama City, FL"), deps);
    expect(sent[0]).toMatch(/I need cost per mile/);
    expect(sent[0]).toMatch(/Nothing was read yet/);
  });

  it("acks a scan, then posts the shortlist summary when the run finishes", async () => {
    const state: StubState = {
      proposals: [],
      spentCents: 0,
      audit: [],
      groupMessages: [],
      memories: [{ content: "cost per mile: $1.20" }, { content: "floor: 50c" }, { content: "diesel $3.50" }, { content: "mpg 7" }],
    };
    const { deps, sent } = makeDeps(state, {
      browserRuntime: {
        route: "shared-vm",
        readBoard: async () => ({ boardSlug: "trulos", status: "ok", loads: [], note: "ok", readAtIso: new Date().toISOString() }),
        watchUrl: (runId: string) => `https://browser.example/watch/${runId}`,
        stopRun: async () => ({ stopped: true, reason: "Stopped." }),
      },
      scoutScan: async () => ({
        runId: "run-1",
        boardReports: [{ boardSlug: "trulos", status: "ok", loadsSeen: 1, note: "ok" }],
        loadsSeen: 1,
        shortlistCount: 1,
        skippedCount: 0,
        proposalId: "proposal-1",
        watchUrl: "https://browser.example/watch/run-1",
        timeSensitive: false,
        summary: "Dispatch Scout — shortlist from Panama City, FL:\n1. Panama City, FL → Atlanta, GA — $1,850",
      }),
    });
    await handleBotTeamGroupUpdate(makeUpdate("scout, scan from Panama City, FL"), deps);
    expect(sent[0]).toMatch(/scanning TruLOS first/);
    expect(sent[0]).toContain("https://browser.example/watch/");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Panama City, FL → Atlanta, GA");
  });

  it("writes skipped ledger rows when the owner denies a shortlist, none on approval", async () => {
    const shortlistRow: ProposalRow = {
      id: "proposal-9",
      company_id: "company-1",
      bot_slug: "dispatch-scout",
      kind: "load-shortlist",
      title: "Shortlist — 1 load from Panama City, FL",
      payload: {
        loads: [
          {
            board: "trulos",
            externalRef: "trulos:abc",
            origin: "Panama City, FL",
            destination: "Atlanta, GA",
            payCents: 185000,
            loadedMiles: 500,
            deadheadMiles: 100,
            perLoadedMileCents: 370,
            brokerName: "Acme Logistics",
          },
        ],
      },
      source_ref: "scout-scan:run-1",
      status: "proposed",
      created_at: new Date().toISOString(),
      decided_at: null,
      decided_by: null,
    };
    const state: StubState = { proposals: [shortlistRow], spentCents: 0, audit: [], groupMessages: [], ledger: [] };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("no"), deps);
    expect(sent[sent.length - 1]).toMatch(/^Dropped:/);
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger?.[0]?.outcome).toBe("skipped");
    expect(state.ledger?.[0]?.notes).toContain("passed on the shortlist");
  });
});

describe("bot-team group mode — Maintenance seat", () => {
  it("answers when called by name, with its identity and the shared reasoning in the turn", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    type RunChatInput = Parameters<NonNullable<GroupHandlerDeps["runChat"]>>[0];
    const seenInputs: RunChatInput[] = [];
    const runChat = vi.fn(async (input: RunChatInput) => {
      seenInputs.push(input);
      return "Oil change is due in 2,000 miles.";
    });
    const { deps, sent } = makeDeps(state, { runChat });
    expect(await handleBotTeamGroupUpdate(makeUpdate("Maintenance, what is due next?"), deps)).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Maintenance: Oil change/);
    expect(seenInputs).toHaveLength(1);
    const instructions = seenInputs[0]!.instructions;
    expect(instructions.some((row) => row.kind === "identity")).toBe(true);
    expect(instructions.some((row) => row.kind === "scope")).toBe(true);
    expect(instructions.filter((row) => row.kind === "reasoning").length).toBeGreaterThanOrEqual(10);
    // Handoff payload is validated state, not a transcript: the turn
    // carries no chat history and no other bot's raw output.
    expect(seenInputs[0]!.history).toEqual([]);
    expect(state.spentCents).toBeGreaterThan(0);
  });

  it("stays quiet on a keyword-only message until Abel routes it — then Abel's handoff posts and Maintenance answers", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const runChat = vi.fn(async () => "unused");
    runChat.mockResolvedValueOnce("ROUTE: maintenance");
    runChat.mockResolvedValueOnce("Your DOT inspection is due in 12 days.");
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("when is the DOT inspection due?"), deps);
    expect(runChat).toHaveBeenCalledTimes(2);
    // The handoff is VISIBLE first (code-generated, no extra model
    // call), then Maintenance's answer — the owner watches the
    // handoff happen.
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/handoff: job=route keywords=inspection,dot hops=0/);
    expect(sent[0]).toMatch(/Abel → Maintenance: routing this one to you/);
    expect(sent[1]).toMatch(/^Maintenance: Your DOT inspection/);
  });

  it("does not answer a keyword-only message Abel does not route — Abel asks the one short question", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const runChat = vi.fn(async () => "Which truck is this about?");
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("my tire is flat"), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Abel: Which truck is this about\?/);
    expect(sent[0]).not.toMatch(/^Maintenance:/);
  });

  it("does not mistake Abel merely mentioning Maintenance for a route", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const runChat = vi.fn(async () => "Maintenance can help with that — what is wrong?");
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("the brakes feel soft"), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Abel: Maintenance can help/);
  });

  it("files a reported defect as an open DVIR item and tells Dispatch Scout the truck is down", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("Maintenance, my tire is flat on truck 2"), deps);
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe("record-draft");
    expect(state.proposals[0]!.bot_slug).toBe("maintenance");
    const payload = state.proposals[0]!.payload as Record<string, unknown>;
    expect(payload.recordKind).toBe("dvir-defect");
    expect(payload.defect).toBe("flat tire");
    expect(payload.status).toBe("open");
    expect(sent[0]).toMatch(/DVIR/);
    expect(sent[0]).toMatch(/Dispatch Scout — truck 2 reported down/);
    expect(sent[0]).toMatch(/Reply Yes to confirm filing/);
  });

  it("drafts a work order with the estimate from the owner's words, never guessed", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(
      makeUpdate("Maintenance, draft a work order for the brake problem, estimate $450"),
      deps,
    );
    expect(state.proposals).toHaveLength(1);
    const payload = state.proposals[0]!.payload as Record<string, unknown>;
    expect(payload.recordKind).toBe("work-order");
    expect(payload.estimateCents).toBe(45000);
    expect(sent[0]).toMatch(/work-order draft ready/i);
    expect(sent[0]).toMatch(/\$450\.00/);
    expect(sent[0]).toMatch(/Reply Yes to approve/);
  });

  it("stages a call plan for a shop — a proposal, never a dial", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("Maintenance, call the shop about the estimate"), deps);
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe("call-plan");
    expect(state.proposals[0]!.bot_slug).toBe("maintenance");
    expect(sent[0]).toMatch(/call plan recorded/i);
    expect(sent[0]).toMatch(/\+1 320-369-0102/);
    expect(sent[0]).toMatch(/No call is placed until you approve it/);
  });

  it("stays quiet on another bot's job — a load message is Scout's, not Maintenance's", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("find me a load"), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(/Maintenance:/);
  });

  it("never files the same Telegram message twice — a redelivery replays the already-filed summary", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    const update = makeUpdate("Maintenance, my tire is flat on truck 2", OWNER_ID, false, 42);
    await handleBotTeamGroupUpdate(update, deps);
    await handleBotTeamGroupUpdate(update, deps);
    expect(state.proposals).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/already filed from your earlier message/i);
    expect(sent[1]).toMatch(/Reply Yes to confirm filing/);
  });

  it("files two different messages as two defects — the idempotency key is per message", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("Maintenance, my tire is flat on truck 2", OWNER_ID, false, 42), deps);
    await handleBotTeamGroupUpdate(makeUpdate("Maintenance, my tire is flat on truck 2", OWNER_ID, false, 43), deps);
    expect(state.proposals).toHaveLength(2);
  });

  it("routes a keyword-only message through Abel when the model key is not configured", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state, { runChat: undefined });
    await handleBotTeamGroupUpdate(makeUpdate("my tire is flat"), deps);
    expect(sent[0]).toMatch(/^Abel: I can't answer that yet/);
  });

  it("posts from Maintenance's own account when its token is configured — no text prefix", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const runChat = vi.fn(async () => "Oil change is due in 2,000 miles.");
    const { deps, sent } = makeDeps(state, { runChat });
    vi.mocked(sendTelegramMessage).mockClear();
    process.env.TELEGRAM_MAINTENANCE_BOT_TOKEN = "maint-token";
    try {
      await handleBotTeamGroupUpdate(makeUpdate("Maintenance, what is due next?"), deps);
    } finally {
      delete process.env.TELEGRAM_MAINTENANCE_BOT_TOKEN;
    }
    expect(sendTelegramMessage).toHaveBeenCalledWith("maint-token", GROUP_ID, "Oil change is due in 2,000 miles.");
    expect(sent).toEqual([]);
  });
});

describe("bot-team group mode — bot-to-bot handoffs to Maintenance", () => {
  const BOT_ENVS = {
    TELEGRAM_ABEL_BOT_USERNAME: "AbelBot",
    TELEGRAM_DISPATCH_SCOUT_BOT_USERNAME: "DispatchScoutBot",
    TELEGRAM_MAINTENANCE_BOT_USERNAME: "MaintenanceBot",
    TELEGRAM_TRACKER_BOT_USERNAME: "TrackerBot",
  } as const;

  /** Run with every bot's username configured (and restored after). */
  function withBotUsernames<T>(fn: () => Promise<T>): Promise<T> {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(BOT_ENVS)) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
    return fn().finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }

  it("answers a runnable handoff from Dispatch Scout with the truck status from open defects", async () => {
    await withBotUsernames(async () => {
      const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDeps(state);
      await handleBotTeamGroupUpdate(makeUpdate("Maintenance, my tire is flat on truck 2"), deps);
      expect(state.proposals).toHaveLength(1);
      await handleBotTeamGroupUpdate(
        makeUpdate(
          "/handoff@MaintenanceBot job=runnable truck=2 hops=0\nDispatch Scout → Maintenance: is truck 2 runnable?",
          555,
          true,
          50,
          { username: "DispatchScoutBot" },
        ),
        deps,
      );
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatch(/Dispatch Scout — Truck status for Dispatch Scout:/);
      expect(sent[1]).toMatch(/Runnable: none reported/);
      expect(sent[1]).toMatch(/Down: truck 2 — flat tire/);
    });
  });

  it("files a defect handoff from another bot through the same intake, idempotent per message", async () => {
    await withBotUsernames(async () => {
      const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDeps(state);
      const update = makeUpdate("/handoff@MaintenanceBot job=defect defect=flat-tire truck=2 hops=0", 111, true, 51, {
        username: "AbelBot",
      });
      await handleBotTeamGroupUpdate(update, deps);
      await handleBotTeamGroupUpdate(update, deps);
      expect(state.proposals).toHaveLength(1);
      expect(state.proposals[0]!.payload).toMatchObject({ recordKind: "dvir-defect", defect: "flat tire" });
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatch(/already filed from your earlier message/i);
    });
  });

  it("works a route handoff from Abel on the owner's message it replies to", async () => {
    await withBotUsernames(async () => {
      const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDeps(state);
      await handleBotTeamGroupUpdate(
        makeUpdate("/handoff@MaintenanceBot job=route keywords=tire hops=0", 111, true, 52, {
          username: "AbelBot",
          replyTo: { text: "Maintenance, my tire is flat on truck 2" },
        }),
        deps,
      );
      expect(state.proposals).toHaveLength(1);
      expect(state.proposals[0]!.payload).toMatchObject({ recordKind: "dvir-defect", defect: "flat tire" });
      expect(sent[0]).toMatch(/Defect filed as an open DVIR item/);
    });
  });

  it("ignores a handoff to Abel — only Maintenance has a bot-to-bot handler so far", async () => {
    await withBotUsernames(async () => {
      const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDeps(state);
      expect(
        await handleBotTeamGroupUpdate(
          makeUpdate("/handoff@AbelBot job=progress about=load hops=0", 555, true, 53, { username: "DispatchScoutBot" }),
          deps,
        ),
      ).toBe("ignored");
      expect(sent).toEqual([]);
    });
  });

  it("ignores a bot the team does not know, even when it addresses Maintenance", async () => {
    await withBotUsernames(async () => {
      const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDeps(state);
      expect(
        await handleBotTeamGroupUpdate(
          makeUpdate("/handoff@MaintenanceBot job=runnable truck=2 hops=0", 999, true, 54, { username: "StrangerBot" }),
          deps,
        ),
      ).toBe("ignored");
      expect(sent).toEqual([]);
    });
  });

  it("audit-logs a malformed handoff and runs nothing", async () => {
    await withBotUsernames(async () => {
      const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDeps(state);
      expect(
        await handleBotTeamGroupUpdate(
          makeUpdate("/handoff@MaintenanceBot job=bogus hops=0", 111, true, 55, { username: "AbelBot" }),
          deps,
        ),
      ).toBe("ignored");
      expect(sent).toEqual([]);
      expect(state.proposals).toHaveLength(0);
      expect(state.audit.some((a) => a.action === "handoff_malformed")).toBe(true);
    });
  });

  it("drops a handoff that has already passed through three bots — the loop guard", async () => {
    await withBotUsernames(async () => {
      const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDeps(state);
      await handleBotTeamGroupUpdate(
        makeUpdate("/handoff@MaintenanceBot job=runnable truck=2 hops=3", 555, true, 56, { username: "DispatchScoutBot" }),
        deps,
      );
      expect(state.proposals).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(/dropping this handoff/);
      expect(state.audit.some((a) => a.action === "handoff_dropped_hop_limit")).toBe(true);
    });
  });

  it("files once when the same message arrives twice at the same moment — the job claim is the in-flight guard", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDeps(state);
    const update = makeUpdate("Maintenance, my tire is flat on truck 2", OWNER_ID, false, 42);
    await Promise.all([handleBotTeamGroupUpdate(update, deps), handleBotTeamGroupUpdate(update, deps)]);
    expect(state.proposals).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  it("asks Tracker where the truck is, and tells Scout the truck is down, in the urgent-defect message", async () => {
    await withBotUsernames(async () => {
      const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDeps(state);
      await handleBotTeamGroupUpdate(makeUpdate("Maintenance, my tire is flat on truck 2"), deps);
      expect(sent[0]).toMatch(/\/handoff@DispatchScoutBot job=progress about=truck-down truck=2 defect=flat-tire hops=0/);
      expect(sent[0]).toMatch(/Dispatch Scout — truck 2 reported down \(flat tire\)/);
      expect(sent[0]).toMatch(/\/handoff@TrackerBot job=location truck=2 hops=0/);
      expect(sent[0]).toMatch(/Maintenance → Tracker: where is truck 2\?/);
    });
  });

  it("answers a known bot that replies to one of Maintenance's messages", async () => {
    await withBotUsernames(async () => {
      const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDeps(state);
      await handleBotTeamGroupUpdate(
        makeUpdate("Maintenance, what is due next?", 555, true, 57, {
          username: "DispatchScoutBot",
          replyTo: { username: "MaintenanceBot", text: "Oil change is due in 2,000 miles." },
        }),
        deps,
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(/^Maintenance: Hi/);
    });
  });

  it("ignores unprompted bot chatter — a bot talking about loads is not Maintenance's to answer", async () => {
    await withBotUsernames(async () => {
      const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDeps(state);
      expect(
        await handleBotTeamGroupUpdate(
          makeUpdate("found a load out of Dallas", 555, true, 58, { username: "DispatchScoutBot" }),
          deps,
        ),
      ).toBe("ignored");
      expect(sent).toEqual([]);
    });
  });
});
