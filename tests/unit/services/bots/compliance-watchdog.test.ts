// Compliance Watchdog: deadline evaluation, alerts, load legality,
// the speak gate, the never-list, reminders, filing, and the sweep.
// Pure parts run with no database; store-backed parts run against an
// in-memory stub of the BotTeamStore interface.
import { describe, expect, it } from "vitest";
import {
  AMBER_DAYS,
  buildWatchdogInstructions,
  checkLoadLegality,
  checkWatchdogAction,
  evaluateChecklist,
  evaluateDeadline,
  fileDocumentCopy,
  flagMissingDutyCoverage,
  formatComplianceAlert,
  formatDefectAlert,
  formatScoutHoldMessage,
  formatTrackerPositionRequest,
  proposeReminder,
  refuseWatchdogAction,
  runWatchdogSweep,
  shouldWatchdogSpeak,
  WATCHDOG_JOB_PROMPT,
  WATCHDOG_TEAM_ROOM_INSTRUCTIONS,
  type ComplianceDeadlineInput,
} from "@/services/bots/compliance-watchdog";
import { REASONING_FORMS, sharedReasoningPrompt } from "@/services/bots/reasoning";
import type {
  BotTeamStore,
  ComplianceDeadlineRow,
  DutySegmentRow,
  OpenDefectRow,
  ProposalRow,
} from "@/services/bots/store";

const NOW = new Date("2026-11-19T12:00:00Z");

function dateOffset(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function currentRows(): ComplianceDeadlineInput[] {
  return [
    { kind: "medical_card", dueDate: dateOffset(90) },
    { kind: "cdl", dueDate: dateOffset(200) },
    { kind: "mvr", dueDate: dateOffset(100) },
    { kind: "clearinghouse_query", dueDate: dateOffset(120) },
    { kind: "drug_test_pool", dueDate: dateOffset(60) },
    { kind: "ucr", dueDate: dateOffset(45) },
    { kind: "irp", dueDate: dateOffset(80) },
    { kind: "mcs_150", dueDate: dateOffset(150) },
    { kind: "annual_inspection", dueDate: dateOffset(70) },
    { kind: "dvir_defect", dueDate: dateOffset(365) },
  ];
}

interface StubState {
  deadlines: ComplianceDeadlineRow[];
  defects: OpenDefectRow[];
  segments: DutySegmentRow[];
  proposals: ProposalRow[];
  audit: { action: string; detail: Record<string, unknown> }[];
}

function makeStub(state: StubState): BotTeamStore {
  let seq = 0;
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
      state.audit.push({ action: input.action, detail: input.detail ?? {} });
    },
    recordLoadOutcome: async () => {},
    ensureGroupRoom: async () => {},
    recordGroupMessage: async () => {},
    recordSpend: async () => {},
    spentThisMonthCents: async () => 0,
    loadBotMemories: async () => [],
    hasAuditorCheck: async () => false,
    findGroupMessage: async () => null,
    listComplianceDeadlines: async () => state.deadlines,
    upsertComplianceDeadline: async (input) => {
      const row: ComplianceDeadlineRow = {
        id: `deadline-${++seq}`,
        company_id: "company-1",
        kind: input.kind,
        subject_ref: input.subjectRef ?? null,
        due_date: input.dueDate ?? null,
        status: input.status ?? "filed",
        source: input.source ?? null,
        notes: input.notes ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      state.deadlines.push(row);
      return row;
    },
    listOpenDefects: async () => state.defects,
    listRecentDutySegments: async () => state.segments,
    hasRecentAlert: async () => false,
    saveBotMemory: async (input) => ({
      id: "memory-new",
      bot_slug: input.botSlug,
      kind: input.kind,
      content: input.content,
      source: input.source ?? "bot",
      created_at: new Date().toISOString(),
    }),
    listRecentAudit: async () => [],
    hasRecentAuditFingerprint: async () => false,
    listHandoffsFor: async () => [],
    listRecentGroupMessages: async () => [],
  };
}

describe("deadline evaluation", () => {
  it("an expired deadline is red", () => {
    const d = evaluateDeadline({ kind: "medical_card", dueDate: dateOffset(-3) }, NOW);
    expect(d.severity).toBe("red");
    expect(d.daysUntil).toBe(-3);
    expect(d.message).toMatch(/expired 3 days ago/);
  });

  it("a deadline due today is red", () => {
    expect(evaluateDeadline({ kind: "cdl", dueDate: dateOffset(0) }, NOW).severity).toBe("red");
  });

  it(`a deadline inside ${AMBER_DAYS} days is amber`, () => {
    const d = evaluateDeadline({ kind: "ucr", dueDate: dateOffset(10) }, NOW);
    expect(d.severity).toBe("amber");
    expect(d.daysUntil).toBe(10);
  });

  it("a deadline far out is ok", () => {
    expect(evaluateDeadline({ kind: "irp", dueDate: dateOffset(90) }, NOW).severity).toBe("ok");
  });

  it("a known-missing deadline is red", () => {
    const d = evaluateDeadline({ kind: "mvr", status: "missing" }, NOW);
    expect(d.severity).toBe("red");
    expect(d.message).toMatch(/No mvr on file/i);
  });

  it("no date on file is unknown, not ok", () => {
    expect(evaluateDeadline({ kind: "mcs_150" }, NOW).severity).toBe("unknown");
  });

  it("a kind with no row at all is a red gap, not a pass", () => {
    const checklist = evaluateChecklist([{ kind: "medical_card", dueDate: dateOffset(90) }], NOW);
    expect(checklist.reds.map((d) => d.kind)).toContain("cdl");
    expect(checklist.reds.length).toBe(9);
  });

  it("alerts name the deadline, what is missing, and the consequence", () => {
    const d = evaluateDeadline({ kind: "medical_card", dueDate: dateOffset(-3) }, NOW);
    const alert = formatComplianceAlert(d);
    expect(alert).toMatch(/^RED — Medical card/);
    expect(alert).toMatch(/expired 3 days ago/);
    expect(alert).toMatch(/cannot legally drive/);
  });
});

describe("HOS coverage and defects", () => {
  it("no duty logs at all is a red flag", () => {
    const flag = flagMissingDutyCoverage([], NOW);
    expect(flag?.severity).toBe("red");
    expect(flag?.message).toMatch(/No duty logs on file/);
  });

  it("a stale duty log is amber, a fresh one is no flag", () => {
    const stale = flagMissingDutyCoverage([{ dutyStatus: "driving", startedAt: "2026-11-17T10:00:00Z" }], NOW);
    expect(stale?.severity).toBe("amber");
    expect(flagMissingDutyCoverage([{ dutyStatus: "driving", startedAt: "2026-11-19T10:00:00Z" }], NOW)).toBeNull();
  });

  it("an open defect formats as a red alert", () => {
    const alert = formatDefectAlert({ id: "d1", description: "steer tire worn to cord", source: "pretrip", createdAt: "2026-11-19T08:00:00Z" });
    expect(alert).toMatch(/^RED — Open DVIR defect/);
    expect(alert).toMatch(/steer tire worn to cord/);
  });
});

describe("load legality", () => {
  it("an expired deadline blocks the load", () => {
    const rows = currentRows();
    rows[0] = { kind: "medical_card", dueDate: dateOffset(-3) };
    const verdict = checkLoadLegality({ checklist: evaluateChecklist(rows, NOW), defects: [], loadRef: "Trip 1903" });
    expect(verdict.verdict).toBe("blocked");
    expect(verdict.summary).toMatch(/^BLOCK/);
    expect(verdict.summary).toMatch(/Trip 1903/);
  });

  it("a missing record cannot confirm the load — it does not prove it illegal", () => {
    const verdict = checkLoadLegality({ checklist: evaluateChecklist([], NOW), defects: [], loadRef: "Trip 1903" });
    expect(verdict.verdict).toBe("cannot-confirm");
    expect(verdict.blocks).toHaveLength(0);
    expect(verdict.summary).toMatch(/cannot confirm/);
  });

  it("an open defect cannot confirm the load — it never decides out-of-service", () => {
    const verdict = checkLoadLegality({
      checklist: evaluateChecklist(currentRows(), NOW),
      defects: [{ id: "d1", description: "air leak", source: "pretrip", createdAt: "2026-11-19T08:00:00Z" }],
    });
    expect(verdict.verdict).toBe("cannot-confirm");
    expect(verdict.summary).toMatch(/repair decision/);
  });

  it("a current checklist with no defects clears the load", () => {
    const verdict = checkLoadLegality({ checklist: evaluateChecklist(currentRows(), NOW), defects: [] });
    expect(verdict.verdict).toBe("clear");
    expect(verdict.summary).toMatch(/no blocks on file/);
  });
});

describe("speak gate", () => {
  it("speaks when called by name or replied to", () => {
    expect(shouldWatchdogSpeak({ text: "Watchdog, check this", via: "mention" })).toBe(true);
    expect(shouldWatchdogSpeak({ text: "yes", via: "reply" })).toBe(true);
  });

  it("speaks on its job words — strong and HOS alike", () => {
    expect(shouldWatchdogSpeak({ text: "when is my medical card due", via: "keyword" })).toBe(true);
    expect(shouldWatchdogSpeak({ text: "how many hours do I have left", via: "keyword" })).toBe(true);
  });

  it("stays quiet when nothing routes to it", () => {
    expect(shouldWatchdogSpeak({ text: "hey", via: "default" })).toBe(false);
    expect(shouldWatchdogSpeak({ text: "find me a load", via: "default" })).toBe(false);
  });
});

describe("hard refusals", () => {
  it("the never-list is denied outright — change_hos_log, file_document, call_outbound", () => {
    expect(refuseWatchdogAction("change_hos_log").allowed).toBe(false);
    expect(refuseWatchdogAction("file_document").allowed).toBe(false);
    expect(refuseWatchdogAction("call_outbound").allowed).toBe(false);
    expect(refuseWatchdogAction("sign_document").allowed).toBe(false);
    expect(refuseWatchdogAction("move_money").allowed).toBe(false);
    expect(refuseWatchdogAction("send_to_broker").allowed).toBe(false);
  });

  it("the never-list wins even with an approved proposal", () => {
    const verdict = checkWatchdogAction({ actionKind: "change_hos_log", group: "hos", hasApprovedProposal: true });
    expect(verdict.allowed).toBe(false);
  });

  it("flagging on HOS is allowed; reading money is denied; sending is execute-gated", () => {
    expect(checkWatchdogAction({ actionKind: "flag", group: "hos" }).allowed).toBe(true);
    expect(checkWatchdogAction({ actionKind: "read", group: "money" }).allowed).toBe(false);
    expect(checkWatchdogAction({ actionKind: "send_to_driver", group: "email" }).allowed).toBe(false);
    expect(checkWatchdogAction({ actionKind: "draft_message", group: "email" }).allowed).toBe(true);
  });
});

describe("reminders and filing", () => {
  it("refuses a reminder to FMCSA or an insurer", async () => {
    const state: StubState = { deadlines: [], defects: [], segments: [], proposals: [], audit: [] };
    const store = makeStub(state);
    const deadline = evaluateDeadline({ kind: "medical_card", dueDate: dateOffset(10) }, NOW);
    const result = await proposeReminder({ store, recipient: "fmcsa", deadline });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/driver or the owner only/);
    expect(state.proposals).toHaveLength(0);
  });

  it("drafts a reminder to the owner as a proposal — nothing is sent", async () => {
    const state: StubState = { deadlines: [], defects: [], segments: [], proposals: [], audit: [] };
    const store = makeStub(state);
    const deadline = evaluateDeadline({ kind: "medical_card", dueDate: dateOffset(10) }, NOW);
    const result = await proposeReminder({ store, recipient: "owner", deadline });
    expect(result.ok).toBe(true);
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe("message-draft");
    expect(state.proposals[0]!.status).toBe("proposed");
  });

  it("filing a document copy writes the deadline row and an audit row — it never approves", async () => {
    const state: StubState = { deadlines: [], defects: [], segments: [], proposals: [], audit: [] };
    const store = makeStub(state);
    const result = await fileDocumentCopy({
      store,
      deadline: { kind: "medical_card", dueDate: dateOffset(365), source: "clinic-scan" },
    });
    expect(result.ok).toBe(true);
    expect(state.deadlines).toHaveLength(1);
    expect(state.deadlines[0]!.status).toBe("filed");
    expect(state.audit.some((a) => a.action === "document_filed")).toBe(true);
  });
});

describe("model-turn instructions and sweep", () => {
  it("the turn carries the job, the whole shared brain, the snapshot, and memories", () => {
    const checklist = evaluateChecklist(currentRows(), NOW);
    const instructions = buildWatchdogInstructions({
      memories: [{ kind: "fact", content: "Owner carries the legal liability." }],
      snapshotText: `COMPLIANCE SNAPSHOT:\n- OK: ${checklist.evaluated[0]!.message}`,
    });
    const joined = instructions.map((b) => b.content).join("\n\n");
    expect(joined).toContain(WATCHDOG_JOB_PROMPT);
    // The shared reasoning engine (PR #101): the same prompt text
    // Abel runs on — every form's rules, unabridged.
    expect(joined).toContain(sharedReasoningPrompt());
    for (const form of REASONING_FORMS) {
      expect(joined).toContain(form.rules);
    }
    // The owner's ten core forms, all present, in Abel's order —
    // no cut-down brain for this seat (owner ruling, 2026-11-19).
    expect(REASONING_FORMS.filter((f) => f.layer === "core").map((f) => f.id)).toEqual([
      "temporal",
      "contextual",
      "causal",
      "practical",
      "self-correction",
      "episodic",
      "theory-of-mind",
      "value-learning",
      "consolidation",
      "restraint",
    ]);
    // The team-room rules ride along: talk to teammates by name,
    // hand work off, pull the owner in only for decisions.
    expect(joined).toContain(WATCHDOG_TEAM_ROOM_INSTRUCTIONS);
    expect(joined).toContain("Owner carries the legal liability.");
  });

  it("handoffs from the team land in the turn as summaries", () => {
    const instructions = buildWatchdogInstructions({
      memories: [],
      snapshotText: "snapshot",
      handoffs: [
        { fromBot: "dispatch-scout", reason: "driver says the medical card was renewed Tuesday", ref: null, deadlineKind: "medical_card" },
      ],
    });
    const joined = instructions.map((b) => b.content).join("\n\n");
    expect(joined).toContain("HANDOFFS WAITING FOR YOU FROM THE TEAM");
    expect(joined).toContain("From dispatch-scout: driver says the medical card was renewed Tuesday");
  });

  it("a missing snapshot is stated as missing, never invented", () => {
    const instructions = buildWatchdogInstructions({ memories: [], snapshotText: null });
    const joined = instructions.map((b) => b.content).join("\n\n");
    expect(joined).toMatch(/checklist is not loaded/);
  });

  it("the sweep returns red and amber alerts with counts", async () => {
    const state: StubState = {
      deadlines: currentRows().map((r, i): ComplianceDeadlineRow => ({
        id: `d${i}`,
        company_id: "company-1",
        kind: r.kind,
        subject_ref: null,
        due_date: r.kind === "medical_card" ? dateOffset(-2) : r.kind === "ucr" ? dateOffset(5) : r.dueDate ?? null,
        status: "filed",
        source: null,
        notes: null,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      })),
      defects: [{ id: "d1", description: "air leak", source: "pretrip", created_at: NOW.toISOString() }],
      segments: [{ duty_status: "driving", started_at: "2026-11-19T10:00:00Z", location: null }],
      proposals: [],
      audit: [],
    };
    const sweep = await runWatchdogSweep({ store: makeStub(state), now: NOW });
    expect(sweep.counts.red).toBeGreaterThanOrEqual(2);
    expect(sweep.counts.amber).toBeGreaterThanOrEqual(1);
    expect(sweep.alerts.some((a) => a.startsWith("RED — Medical card"))).toBe(true);
    expect(sweep.alerts.some((a) => a.startsWith("AMBER — UCR"))).toBe(true);
    expect(sweep.alerts.some((a) => a.includes("air leak"))).toBe(true);
  });
});

describe("team-room posts (owner's model, 2026-11-19)", () => {
  it("a blocked checklist speaks to Dispatch Scout by name — hold, before a load is offered", () => {
    const rows = currentRows().map((r) => (r.kind === "medical_card" ? { ...r, dueDate: dateOffset(-2) } : r));
    const checklist = evaluateChecklist(rows, NOW);
    const hold = formatScoutHoldMessage({ checklist, defects: [] });
    expect(hold).not.toBeNull();
    expect(hold).toContain("Dispatch Scout — HOLD on new loads");
    expect(hold).toContain("The owner has the final word");
  });

  it("a cannot-confirm checklist gives Scout the heads-up version, not a hold", () => {
    const rows = currentRows().filter((r) => r.kind !== "mvr");
    const checklist = evaluateChecklist(rows, NOW);
    const headsUp = formatScoutHoldMessage({ checklist, defects: [] });
    expect(headsUp).not.toBeNull();
    expect(headsUp).toContain("Dispatch Scout — before you offer a load");
    expect(headsUp).not.toContain("HOLD");
  });

  it("a clear checklist earns Scout silence", () => {
    const checklist = evaluateChecklist(currentRows(), NOW);
    expect(formatScoutHoldMessage({ checklist, defects: [] })).toBeNull();
  });

  it("an amber deadline on a running truck asks Tracker for the position, by name", () => {
    const rows = currentRows().map((r) => (r.kind === "annual_inspection" ? { ...r, dueDate: dateOffset(10) } : r));
    const checklist = evaluateChecklist(rows, NOW);
    const ask = formatTrackerPositionRequest(
      { checklist, segments: [{ dutyStatus: "driving", startedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), location: "I-20 near Tyler, TX" }] },
      NOW,
    );
    expect(ask).not.toBeNull();
    expect(ask!.deadlineKind).toBe("annual_inspection");
    expect(ask!.text).toContain("Tracker — I need the truck's current position");
    expect(ask!.text).toContain("Annual inspection");
    expect(ask!.text).toContain("I-20 near Tyler, TX");
  });

  it("no running evidence — no position ask (restraint)", () => {
    const rows = currentRows().map((r) => (r.kind === "annual_inspection" ? { ...r, dueDate: dateOffset(10) } : r));
    const checklist = evaluateChecklist(rows, NOW);
    expect(formatTrackerPositionRequest({ checklist, segments: [] }, NOW)).toBeNull();
    const stale = formatTrackerPositionRequest(
      { checklist, segments: [{ dutyStatus: "off_duty", startedAt: new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(), location: null }] },
      NOW,
    );
    expect(stale).toBeNull();
  });

  it("the sweep itself computes both team posts", async () => {
    const state: StubState = {
      deadlines: currentRows().map((r) =>
        r.kind === "medical_card"
          ? { id: "d1", company_id: "company-1", kind: r.kind, subject_ref: null, due_date: dateOffset(-2), status: "filed" as const, source: null, notes: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString() }
          : { id: `d-${r.kind}`, company_id: "company-1", kind: r.kind, subject_ref: null, due_date: r.dueDate ?? null, status: "filed" as const, source: null, notes: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString() },
      ),
      defects: [],
      segments: [{ duty_status: "driving", started_at: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(), location: "US-49, Hattiesburg, MS" }],
      proposals: [],
      audit: [],
    };
    const sweep = await runWatchdogSweep({ store: makeStub(state), now: NOW });
    expect(sweep.scoutHold).toContain("Dispatch Scout — HOLD");
    expect(sweep.trackerRequest).not.toBeNull();
    expect(sweep.trackerRequest!.deadlineKind).toBe("medical_card");
  });
});
