// Compliance Watchdog: deadline evaluation, HOS alert classification,
// the pre-booking legality verdict, the propose-only gate, and the
// group-room wiring. All data is stubbed — the bot reads the app's
// records, and these tests pin what it does with what it reads.
import { describe, expect, it } from "vitest";
import {
  checkLoadLegality,
  evaluateDeadlines,
  evaluateHos,
  parseWatchdogPreferences,
  runWatchdogCheck,
  type CredentialFact,
  type WatchdogData,
  type WatchdogReport,
} from "@/services/bots/compliance-watchdog";
import { checkBotAction } from "@/services/bots/guardrails";
import { handleBotTeamGroupUpdate, type GroupHandlerDeps } from "@/services/bots/group";
import { GROUP_SEATS_PHASE_0 } from "@/services/bots/registry";
import { routeGroupMessage } from "@/services/bots/router";
import type { BotTeamStore } from "@/services/bots/store";
import { snapshotFromRows, type HosWindowSnapshot } from "@/services/api/hos-window";
import { PROVISIONAL_HOS_CONFIG } from "@/lib/hos-cycle";
import type { DutyLog } from "@/types/entities";
import type { TelegramUpdate } from "@/services/telegram/dispatch-bot";

const H = 3_600_000;
const NOW = new Date("2026-11-19T17:00:00Z");
const TODAY = "2026-11-19";

const row = (id: string, duty_status: DutyLog["duty_status"], ms: number) =>
  ({ id, duty_status, started_at: new Date(ms).toISOString() }) as DutyLog;

/** Plenty of hours, nothing due: 2h driving after a long rest. */
function cleanSnapshot(): HosWindowSnapshot {
  return snapshotFromRows(
    [row("a", "off_duty", NOW.getTime() - 40 * H), row("b", "driving", NOW.getTime() - 2 * H)],
    PROVISIONAL_HOS_CONFIG,
    NOW,
  );
}

/** 11 hours of driving ending now — the driving limit is reached. */
function limitSnapshot(): HosWindowSnapshot {
  return snapshotFromRows([row("a", "driving", NOW.getTime() - 11 * H)], PROVISIONAL_HOS_CONFIG, NOW);
}

const goodCreds: CredentialFact[] = [
  { kind: "medical_card", label: "Medical card", expiresOn: "2027-06-01" },
  { kind: "cdl", label: "CDL", expiresOn: "2028-01-15" },
  { kind: "annual_inspection", label: "Annual inspection", expiresOn: "2027-03-01" },
  { kind: "registration_irp", label: "Registration / IRP", expiresOn: "2027-03-31" },
  { kind: "insurance", label: "Insurance", expiresOn: "2027-05-01" },
];

describe("watchdog deadlines", () => {
  it("flags an expired medical card red, with the days spelled out", () => {
    const creds = goodCreds.map((c) => (c.kind === "medical_card" ? { ...c, expiresOn: "2026-11-07" } : c));
    const alerts = evaluateDeadlines(creds, TODAY);
    const medical = alerts.find((a) => a.subject.startsWith("Medical card"));
    expect(medical?.severity).toBe("red");
    expect(medical?.subject).toContain("expired 12 days ago");
  });

  it("flags a deadline inside the amber window amber", () => {
    const creds = goodCreds.map((c) => (c.kind === "cdl" ? { ...c, expiresOn: "2026-11-28" } : c));
    const alerts = evaluateDeadlines(creds, TODAY);
    const cdl = alerts.find((a) => a.subject.startsWith("CDL"));
    expect(cdl?.severity).toBe("amber");
    expect(cdl?.subject).toContain("expires in 9 days");
  });

  it("treats missing required paper as a red block, missing optional paper as amber", () => {
    const creds = goodCreds.filter((c) => c.kind !== "medical_card" && c.kind !== "insurance");
    const alerts = evaluateDeadlines(creds, TODAY);
    expect(alerts.find((a) => a.subject.startsWith("Medical card"))?.severity).toBe("red");
    expect(alerts.find((a) => a.subject.startsWith("Insurance"))?.severity).toBe("amber");
  });

  it("a renewed credential supersedes the expired one", () => {
    const creds = [
      ...goodCreds,
      { kind: "medical_card", label: "Medical card (old)", expiresOn: "2026-10-01" },
    ];
    const alerts = evaluateDeadlines(creds, TODAY);
    expect(alerts.some((a) => a.subject.startsWith("Medical card"))).toBe(false);
  });

  it("stays quiet when everything is comfortably in date", () => {
    expect(evaluateDeadlines(goodCreds, TODAY)).toEqual([]);
  });

  it("watches register rows outside the tracked kinds too", () => {
    const creds = [...goodCreds, { kind: "other", label: "IFTA license", expiresOn: "2026-11-25" }];
    const alerts = evaluateDeadlines(creds, TODAY);
    expect(alerts.some((a) => a.subject.startsWith("IFTA license") && a.severity === "amber")).toBe(true);
  });

  it("honors a wider amber window from memory", () => {
    const creds = goodCreds.map((c) => (c.kind === "cdl" ? { ...c, expiresOn: "2027-01-10" } : c));
    expect(evaluateDeadlines(creds, TODAY, 30).some((a) => a.subject.startsWith("CDL"))).toBe(false);
    expect(evaluateDeadlines(creds, TODAY, 60).some((a) => a.subject.startsWith("CDL"))).toBe(true);
  });
});

describe("watchdog hours", () => {
  it("says plainly when there are no logs to verify", () => {
    const alerts = evaluateHos(snapshotFromRows([], PROVISIONAL_HOS_CONFIG, NOW));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("amber");
    expect(alerts[0]?.subject).toContain("no duty logs on file");
  });

  it("classifies a reached driving limit as red", () => {
    const alerts = evaluateHos(limitSnapshot());
    expect(alerts.some((a) => a.severity === "red" && a.subject.includes("Driving limit"))).toBe(true);
  });

  it("raises nothing on a clean snapshot with cycle time to spare", () => {
    expect(evaluateHos(cleanSnapshot())).toEqual([]);
  });
});

describe("watchdog legality verdict", () => {
  it("clears the run when records are read and nothing blocks", () => {
    const verdict = checkLoadLegality({ credentials: goodCreds, snapshot: cleanSnapshot(), today: TODAY });
    expect(verdict).toEqual({ legal: true, verified: true, reasons: [] });
  });

  it("blocks on an expired medical card and names it", () => {
    const creds = goodCreds.map((c) => (c.kind === "medical_card" ? { ...c, expiresOn: "2026-11-01" } : c));
    const verdict = checkLoadLegality({ credentials: creds, snapshot: cleanSnapshot(), today: TODAY });
    expect(verdict.legal).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("Medical card expired"))).toBe(true);
  });

  it("blocks on a missing CDL", () => {
    const creds = goodCreds.filter((c) => c.kind !== "cdl");
    const verdict = checkLoadLegality({ credentials: creds, snapshot: cleanSnapshot(), today: TODAY });
    expect(verdict.legal).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("CDL is not on file"))).toBe(true);
  });

  it("blocks when the hours say the limit is reached", () => {
    const verdict = checkLoadLegality({ credentials: goodCreds, snapshot: limitSnapshot(), today: TODAY });
    expect(verdict.legal).toBe(false);
    expect(verdict.reasons.some((r) => r.startsWith("Hours:"))).toBe(true);
  });

  it("never clears anyone on unread records", () => {
    const verdict = checkLoadLegality({ credentials: null, snapshot: null, today: TODAY });
    expect(verdict.legal).toBe(false);
    expect(verdict.verified).toBe(false);
  });
});

describe("watchdog preferences", () => {
  it("parses the amber window out of stored memories", () => {
    expect(parseWatchdogPreferences([{ content: "amber: 45" }]).amberDays).toBe(45);
    expect(parseWatchdogPreferences([{ content: "Amber days: 10 for deadlines" }]).amberDays).toBe(10);
  });

  it("falls back to 30 days when nothing parses — never guesses", () => {
    expect(parseWatchdogPreferences([{ content: "he likes coffee" }]).amberDays).toBe(30);
    expect(parseWatchdogPreferences([]).amberDays).toBe(30);
  });
});

describe("watchdog guardrails — alerts only, by construction", () => {
  it("may flag on the groups it can read", () => {
    expect(checkBotAction({ botSlug: "compliance-watchdog", actionKind: "flag", group: "app-actions" }).allowed).toBe(true);
    expect(checkBotAction({ botSlug: "compliance-watchdog", actionKind: "flag", group: "hos" }).allowed).toBe(true);
  });

  it("may never edit a log — not even with an approved proposal", () => {
    const denied = checkBotAction({
      botSlug: "compliance-watchdog",
      actionKind: "change_hos_log",
      group: "hos",
      hasApprovedProposal: true,
    });
    expect(denied.allowed).toBe(false);
  });

  it("may never call out, book, pay, or sign", () => {
    for (const actionKind of ["call_outbound", "book_load", "pay", "sign_document"] as const) {
      expect(
        checkBotAction({ botSlug: "compliance-watchdog", actionKind, group: "app-actions", hasApprovedProposal: true }).allowed,
      ).toBe(false);
    }
  });

  it("holds no draft pen on app-actions — flag scope is not draft scope", () => {
    expect(checkBotAction({ botSlug: "compliance-watchdog", actionKind: "draft_message", group: "app-actions" }).allowed).toBe(false);
  });
});

function stubStore(audit: { action: string }[], memories: { content: string }[] = []): BotTeamStore {
  return {
    companyId: "company-1",
    loadBotMemories: async () => memories.map((m, i) => ({
      id: `m-${i}`,
      bot_slug: "compliance-watchdog" as const,
      kind: "preference" as const,
      source: "test",
      content: m.content,
      created_at: NOW.toISOString(),
    })),
    logAudit: async (input) => {
      audit.push({ action: input.action });
    },
  } as unknown as BotTeamStore;
}

function stubData(credentials: CredentialFact[], snapshot: HosWindowSnapshot): WatchdogData {
  return {
    loadCredentials: async () => credentials,
    loadHosSnapshot: async () => snapshot,
  };
}

describe("runWatchdogCheck", () => {
  it("raises the alerts, audits them, and blocks the run on an expired medical card", async () => {
    const audit: { action: string }[] = [];
    const creds = goodCreds.map((c) => (c.kind === "medical_card" ? { ...c, expiresOn: "2026-11-07" } : c));
    const report = await runWatchdogCheck({
      store: stubStore(audit),
      data: stubData(creds, cleanSnapshot()),
      now: () => NOW,
    });
    expect(report.legality.legal).toBe(false);
    expect(report.summary).toContain("Legal to run: NO");
    expect(report.summary).toContain("Medical card — expired");
    expect(audit.some((a) => a.action === "alert_raised")).toBe(true);
    expect(audit.some((a) => a.action === "watchdog_check")).toBe(true);
  });

  it("reports all clear when the records are clean", async () => {
    const report = await runWatchdogCheck({
      store: stubStore([]),
      data: stubData(goodCreds, cleanSnapshot()),
      now: () => NOW,
    });
    expect(report.alerts).toEqual([]);
    expect(report.summary).toContain("All clear");
    expect(report.summary).toContain("Legal to run: yes");
  });

  it("clears no one when data access is not configured", async () => {
    const report = await runWatchdogCheck({ store: null, data: null, now: () => NOW });
    expect(report.legality.verified).toBe(false);
    expect(report.summary).toContain("cannot verify");
  });

  it("clears no one and names the failed read when a read throws", async () => {
    const failing: WatchdogData = {
      loadCredentials: async () => {
        throw new Error("db down");
      },
      loadHosSnapshot: async () => cleanSnapshot(),
    };
    const report = await runWatchdogCheck({ store: null, data: failing, now: () => NOW });
    expect(report.legality.verified).toBe(false);
    expect(report.summary).toContain("could not read the credential register");
  });
});

describe("watchdog in the group room", () => {
  const OWNER_ID = 111222333;
  const GROUP_ID = -1001234567890;

  function makeUpdate(text: string): TelegramUpdate {
    return {
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: OWNER_ID, is_bot: false },
        chat: { id: GROUP_ID, type: "supergroup" },
        text,
      },
    };
  }

  function makeDeps(overrides: Partial<GroupHandlerDeps> = {}): { deps: GroupHandlerDeps; sent: string[] } {
    const sent: string[] = [];
    const groupStore = {
      companyId: "company-1",
      ensureGroupRoom: async () => {},
      recordGroupMessage: async () => {},
      listOpenProposals: async () => [],
      loadBotMemories: async () => [],
      logAudit: async () => {},
    } as unknown as BotTeamStore;
    const deps: GroupHandlerDeps = {
      botToken: "token",
      allowedChatId: String(OWNER_ID),
      groupChatId: String(GROUP_ID),
      companyId: "company-1",
      store: groupStore,
      sendMessage: async (_chatId, text) => {
        sent.push(text);
        return [1];
      },
      watchdogCheck: async (): Promise<WatchdogReport> => ({
        alerts: [],
        legality: { legal: true, verified: true, reasons: [] },
        summary: "All clear — no deadline inside the watch window, no HOS warnings.",
        checkedAt: NOW.toISOString(),
      }),
      ...overrides,
    };
    return { deps, sent };
  }

  it("is seated — the router reaches it and marks it seated", () => {
    expect(GROUP_SEATS_PHASE_0).toContain("compliance-watchdog");
    const route = routeGroupMessage({ text: "watchdog, check my hours", senderKind: "owner" });
    expect(route.target).toBe("compliance-watchdog");
    expect(route.seated).toBe(true);
  });

  it("posts its check in the group under its own name", async () => {
    const { deps, sent } = makeDeps();
    expect(await handleBotTeamGroupUpdate(makeUpdate("watchdog, run a check"), deps)).toBe("handled");
    expect(sent.some((text) => text.startsWith("Compliance Watchdog:"))).toBe(true);
    expect(sent.some((text) => text.includes("All clear"))).toBe(true);
  });

  it("a failed check posts a loud fallback that clears no one", async () => {
    const { deps, sent } = makeDeps({
      watchdogCheck: async () => {
        throw new Error("boom");
      },
    });
    expect(await handleBotTeamGroupUpdate(makeUpdate("compliance, check the hours"), deps)).toBe("handled");
    expect(sent.some((text) => text.includes("clearing no one"))).toBe(true);
  });
});
