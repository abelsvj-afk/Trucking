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
  proposeReminder,
  refuseWatchdogAction,
  runWatchdogSweep,
  shouldWatchdogSpeak,
  WATCHDOG_JOB_PROMPT,
  type ComplianceDeadlineInput,
} from "@/services/bots/compliance-watchdog";
import { buildSharedReasoningText, SHARED_REASONING_BLOCKS } from "@/services/bots/reasoning";
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
  it("the turn carries the job, all ten reasoning forms, the snapshot, and memories", () => {
    const checklist = evaluateChecklist(currentRows(), NOW);
    const instructions = buildWatchdogInstructions({
      memories: [{ kind: "fact", content: "Owner carries the legal liability." }],
      snapshotText: `COMPLIANCE SNAPSHOT:\n- OK: ${checklist.evaluated[0]!.message}`,
    });
    const joined = instructions.map((b) => b.content).join("\n\n");
    expect(joined).toContain(WATCHDOG_JOB_PROMPT);
    expect(joined).toContain(buildSharedReasoningText());
    for (const block of SHARED_REASONING_BLOCKS) {
      expect(joined).toContain(block.text);
    }
    expect(joined).toContain("Owner carries the legal liability.");
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
