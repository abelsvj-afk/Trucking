// Dispatch Scout scan run — the orchestrator (Phase 1; plan docs/bot-team-build-plan.md).
// One run: walk the ranked boards at human pace, price what can be
// priced honestly, shortlist 3-5, write the ledger, file the
// proposal. Propose-only: nothing here books, signs, or messages a
// broker. An approved shortlist means "go after these loads" — the
// booking itself is still the owner's job, outside this module.
//
// Ledger honesty, read this before changing it:
// - A load the scan looked at and did NOT shortlist is written to
//   bot_load_ledger at scan time with outcome "skipped" and the
//   plain-words reason (below the floor, no miles, auditor failed).
// - A shortlisted load gets NO ledger row at scan time: it has no
//   outcome yet, it is waiting on the owner. When he denies the
//   shortlist, recordShortlistDecision writes "skipped" rows for
//   each of its loads. When he approves it, nothing is written yet
//   — the "booked" row lands when the load is actually booked, via
//   the load flow (open item, see the plan doc).
// - The ledger rows written here carry board facts only (rate,
//   miles, broker) plus the reason. The priced math lives in the
//   proposal payload, not the ledger.
//
// Miles honesty:
// - Deadhead comes from the board when the board gives it, and
//   from nowhere else. Free boards do not know where the truck is,
//   so deadhead is usually missing and those loads are unpriceable
//   — skipped with the reason, never guessed. Wiring the app's
//   routing (geocode truck + pickup, road miles) so deadhead is
//   computed, not guessed, is the next build after this one.
// - A load already at the pickup (true zero deadhead) is also
//   unpriceable in this cut (load-math.ts) until that routing
//   source exists.
//
// Quiet hours: scans the owner asks for in the group get their
// answer right away (a reply, not a proactive send). Scheduled
// scans (the always-on VM scheduler, design doc) hold
// owner-facing posts during quiet hours 9 PM-6 AM ET unless the
// shortlist is time-sensitive — timeSensitive on the result is the
// flag the scheduler reads.

import { randomUUID } from "node:crypto";
import { formatMoney } from "@/lib/money-format";
import { FREE_BOARDS, walkBoards, type BoardLoad, type BoardReport } from "./boards";
import { createBrowserRuntime, HUMAN_PACE, type BrowserRuntime } from "./browser-runtime";
import { checkBotAction } from "./guardrails";
import { buildShortlist, shortlistProposalPayload, type ShortlistResult } from "./shortlist";
import type { BotTeamStore } from "./store";

export interface ScoutScanInput {
  /** Truck's current city/state, e.g. "Panama City, FL". */
  origin: string;
  /** Owner's all-in cost per mile, EXCLUDING fuel, in cents. */
  costPerMileCents: number;
  /** Minimum profit per ALL mile the owner will run for, in cents. */
  floorPerAllMileCents: number;
  dieselCentsPerGallon: number;
  mpg: number;
  /** Equipment to filter on ("dry van" / "reefer" / "flatbed"). Null = no filter. */
  equipment?: string | null;
  maxShortlist?: number;
  /** Run id for the live-watch link. Generated when not given. */
  runId?: string;
}

export interface ScoutScanDeps {
  runtime: BrowserRuntime;
  store: BotTeamStore | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface ScoutScanResult {
  runId: string;
  boardReports: BoardReport[];
  loadsSeen: number;
  shortlistCount: number;
  skippedCount: number;
  proposalId: string | null;
  watchUrl: string | null;
  /** True when a shortlisted load picks up within 6 hours — the scheduler treats that as time-sensitive. */
  timeSensitive: boolean;
  summary: string;
}

const TIME_SENSITIVE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Default sleep: a real timer. Tests pass a stub that records the waits. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function equipmentMatches(load: BoardLoad, equipment: string | null | undefined): boolean {
  if (!equipment || equipment.trim() === "") return true;
  if (load.equipment === null) return true; // Unknown equipment is never a reason to drop a load.
  return load.equipment.toLowerCase().includes(equipment.trim().toLowerCase());
}

/** A shortlisted load picks up within 6 hours of now. Date-only pickups count from midnight. */
function isTimeSensitive(result: ShortlistResult, now: Date): boolean {
  for (const entry of result.shortlist) {
    const pickupDate = entry.priced.load.pickupDate;
    if (!pickupDate) continue;
    const pickupMs = Date.parse(pickupDate);
    if (Number.isNaN(pickupMs)) continue;
    if (pickupMs - now.getTime() <= TIME_SENSITIVE_WINDOW_MS && pickupMs >= now.getTime() - TIME_SENSITIVE_WINDOW_MS) {
      return true;
    }
  }
  return false;
}

function ledgerNotes(reason: string): string {
  return reason;
}

export async function runScoutScan(input: ScoutScanInput, deps: ScoutScanDeps): Promise<ScoutScanResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ? deps.now() : new Date();
  const runId = input.runId ?? randomUUID();
  const watchUrl = deps.runtime.watchUrl(runId);
  const empty = (boardReports: BoardReport[], summary: string): ScoutScanResult => ({
    runId,
    boardReports,
    loadsSeen: 0,
    shortlistCount: 0,
    skippedCount: 0,
    proposalId: null,
    watchUrl,
    timeSensitive: false,
    summary,
  });

  // The gate: Scout drafts shortlists on app-actions. Anything else
  // is refused here, in plain words, before a board is read.
  const gate = checkBotAction({ botSlug: "dispatch-scout", actionKind: "draft_shortlist", group: "app-actions" });
  if (!gate.allowed) {
    return empty([], `Dispatch Scout: ${gate.reason}`);
  }

  // Walk the boards at human pace: at least HUMAN_PACE between
  // reads. The first read goes at once; every read after it waits.
  let lastReadAtMs = 0;
  const { loads, boardReports } = await walkBoards(async (board) => {
    const elapsed = Date.now() - lastReadAtMs;
    if (lastReadAtMs > 0 && elapsed < HUMAN_PACE.minGapMsBetweenReads) {
      await sleep(HUMAN_PACE.minGapMsBetweenReads - elapsed);
    }
    const result = await deps.runtime.readBoard(board.slug, board.url, runId);
    lastReadAtMs = Date.now();
    return result;
  }, { maxBoards: HUMAN_PACE.maxBoardsPerRun });

  const kept: BoardLoad[] = [];
  const equipmentSkipped: { load: BoardLoad; reason: string }[] = [];
  for (const load of loads) {
    if (equipmentMatches(load, input.equipment)) {
      kept.push(load);
    } else {
      equipmentSkipped.push({ load, reason: `Equipment mismatch: the load is ${load.equipment ?? "unknown equipment"}, not ${input.equipment}.` });
    }
  }

  const result = buildShortlist({
    loads: kept,
    costPerMileCents: input.costPerMileCents,
    floorPerAllMileCents: input.floorPerAllMileCents,
    dieselCentsPerGallon: input.dieselCentsPerGallon,
    mpg: input.mpg,
    maxShortlist: input.maxShortlist,
  });
  const allSkipped = [...equipmentSkipped, ...result.skipped];

  const store = deps.store;
  let proposalId: string | null = null;
  let storeNote: string | null = null;
  if (store) {
    // Ledger first: every load NOT shortlisted, with its reason.
    // Shortlisted loads get their row when the owner decides.
    for (const entry of allSkipped) {
      try {
        await store.recordLoadOutcome({
          loadRef: entry.load.externalRef,
          brokerName: entry.load.brokerName,
          origin: entry.load.origin,
          destination: entry.load.destination,
          rateCentsPerLoadedMile: entry.load.rateCentsPerLoadedMile,
          loadedMiles: entry.load.loadedMiles,
          deadheadMiles: entry.load.deadheadMiles,
          payCents: entry.load.rateCents,
          outcome: "skipped",
          notes: ledgerNotes(entry.reason),
        });
      } catch (error) {
        console.error("[bot-team] scout scan ledger write failed", error);
      }
    }
    // Proposal: only when the shortlist is non-empty. An empty
    // shortlist is a report, not a proposal — nothing to approve.
    if (result.shortlist.length > 0) {
      try {
        const proposal = await store.createProposal({
          botSlug: "dispatch-scout",
          kind: "load-shortlist",
          title: `Shortlist — ${result.shortlist.length} load${result.shortlist.length === 1 ? "" : "s"} from ${input.origin}`,
          payload: shortlistProposalPayload(result),
          sourceRef: `scout-scan:${runId}`,
        });
        proposalId = proposal.id;
        await store.logAudit({
          botSlug: "dispatch-scout",
          actor: "bot",
          action: "proposal_created",
          targetRef: proposal.id,
          detail: { kind: "load-shortlist", runId, shortlisted: result.shortlist.length, skipped: allSkipped.length },
        });
      } catch (error) {
        console.error("[bot-team] scout scan proposal failed", error);
        storeNote = "I could not save the shortlist proposal — the team database did not take it. The shortlist below is still good to read.";
      }
    }
  } else {
    storeNote = "The team database is not configured on the server, so nothing was recorded — the shortlist below is still good to read.";
  }

  const timeSensitive = isTimeSensitive(result, now);
  const boardLines = boardReports.map((report) => {
    const board = FREE_BOARDS.find((candidate) => candidate.slug === report.boardSlug);
    const name = board ? board.name : report.boardSlug;
    return `${name}: ${report.status === "ok" ? `${report.loadsSeen} usable load${report.loadsSeen === 1 ? "" : "s"}` : report.note}`;
  });
  const loadLines = result.shortlist.map((entry, index) => {
    const priced = entry.priced;
    const load = priced.load;
    const warning = entry.warnings.length > 0 ? ` — ${entry.warnings.join(" ")}` : "";
    const brokerBits: string[] = [];
    if (load.brokerName) brokerBits.push(load.brokerName);
    const creditBits: string[] = [];
    if (load.brokerCreditScore !== null) creditBits.push(`credit ${load.brokerCreditScore}`);
    if (load.brokerDaysToPay !== null) creditBits.push(`${load.brokerDaysToPay} days to pay`);
    if (creditBits.length > 0) brokerBits.push(`(${creditBits.join(", ")})`);
    const brokerLine = brokerBits.length > 0 ? ` · ${brokerBits.join(" ")}` : "";
    return (
      `${index + 1}. ${load.origin} → ${load.destination} — ${formatMoney(priced.payCents)} · ` +
      `${priced.loadedMiles} loaded + ${priced.deadheadMiles} deadhead mi · ` +
      `${formatMoney(priced.perAllMilesCents)}/all mi · ${formatMoney(priced.profitCents)} profit` +
      brokerLine +
      `${warning}`
    );
  });
  const topSkipReasons = topReasons(allSkipped, 3);
  const lines = [
    `Dispatch Scout — shortlist from ${input.origin}:`,
    ...loadLines,
    ...(result.shortlist.length === 0
      ? [`No loads qualified. ${boardLines.join(" ")}`, `Skipped ${allSkipped.length}: ${topSkipReasons.length > 0 ? topSkipReasons.join("; ") : "no loads seen."}`]
      : [`Boards: ${boardLines.join(" | ")}`, `Skipped ${allSkipped.length} other load${allSkipped.length === 1 ? "" : "s"}${topSkipReasons.length > 0 ? `: ${topSkipReasons.join("; ")}` : "."}`]),
    ...(timeSensitive ? ["One of these picks up within 6 hours — time-sensitive."] : []),
    ...(watchUrl ? [`Watch the browser live: ${watchUrl}`] : []),
    ...(storeNote ? [storeNote] : []),
    ...(result.shortlist.length > 0 ? ["Reply Yes to approve this shortlist, No to drop it."] : ["Nothing worth taking yet — tell me where the truck is when you want another look."]),
  ];
  return {
    runId,
    boardReports,
    loadsSeen: loads.length,
    shortlistCount: result.shortlist.length,
    skippedCount: allSkipped.length,
    proposalId,
    watchUrl,
    timeSensitive,
    summary: lines.join("\n"),
  };
}

/** The most common skip reasons, as "reason (n)". */
function topReasons(skipped: { reason: string }[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const entry of skipped) {
    const reason = entry.reason.split(" — ")[0] ?? entry.reason;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => `${reason} (${count})`);
}

/**
 * What the owner asked for, out of a group message: the truck's
 * origin and the equipment. "scout, scan from Panama City, FL" or
 * "find dry van loads near Atlanta, GA". No origin in the text
 * means null — the caller asks the owner instead of guessing.
 */
export function parseScanRequest(text: string): { origin: string | null; equipment: string | null } {
  // The city follows "from"/"near"/"out of"/"around" when the owner
  // says it that way; otherwise a bare "City, ST" anywhere in the
  // text. The preposition form wins — a greedy bare match would
  // swallow the words before the city ("scan from Panama City, FL"
  // is not a city).
  const afterPreposition = text.match(/(?:from|near|out of|around)\s+([A-Z][A-Za-z .'-]*?,\s*[A-Z]{2})\b/);
  const bare = text.match(/([A-Z][A-Za-z .'-]*?,\s*[A-Z]{2})\b/);
  const match = afterPreposition ?? bare;
  const origin = match && match[1] ? match[1].trim() : null;
  const equipmentMatch = text.match(/\b(dry van|reefer|flatbed)\b/i);
  return { origin, equipment: equipmentMatch && equipmentMatch[1] ? equipmentMatch[1].toLowerCase() : null };
}

export interface CostPreferences {
  costPerMileCents?: number;
  floorPerAllMileCents?: number;
  dieselCentsPerGallon?: number;
  mpg?: number;
}

/**
 * Cost inputs out of the Scout's stored preference memories
 * (bot_team_memories, kind "preference"). Accepted forms only —
 * anything else is ignored, never guessed:
 *   cost per mile / floor / diesel: "$1.20" or "1.20" (dollars) or
 *   "120c" / "120 cents" (cents). A bare whole number is read as
 *   cents ($120 a mile does not exist).
 *   mpg: a plain number.
 * A memory that does not parse simply does not count.
 */
export function parseCostPreferences(memories: { content: string }[]): CostPreferences {
  const found: CostPreferences = {};
  const parseMoney = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const isDollars = trimmed.includes("$") || trimmed.includes(".");
    const digits = trimmed.replace(/[^0-9.]/g, "");
    if (digits === "") return null;
    const value = Number(digits);
    if (!Number.isFinite(value) || value <= 0) return null;
    return isDollars ? Math.round(value * 100) : Math.round(value);
  };
  for (const memory of memories) {
    const text = memory.content;
    if (found.costPerMileCents === undefined) {
      const match = text.match(/cost(?:\s+per\s+mile)?\s*[:=]?\s*(\$?\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:c|cents)?)/i);
      if (match && match[1]) {
        const parsed = parseMoney(match[1]);
        if (parsed !== null) found.costPerMileCents = parsed;
      }
    }
    if (found.floorPerAllMileCents === undefined) {
      const match = text.match(/floor\s*[:=]?\s*(\$?\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:c|cents)?)/i);
      if (match && match[1]) {
        const parsed = parseMoney(match[1]);
        if (parsed !== null) found.floorPerAllMileCents = parsed;
      }
    }
    if (found.dieselCentsPerGallon === undefined) {
      const match = text.match(/diesel\s*[:=]?\s*(\$?\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:c|cents)?)/i);
      if (match && match[1]) {
        const parsed = parseMoney(match[1]);
        if (parsed !== null) found.dieselCentsPerGallon = parsed;
      }
    }
    if (found.mpg === undefined) {
      const match = text.match(/mpg\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (match && match[1]) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed) && parsed > 0) found.mpg = parsed;
      }
    }
  }
  return found;
}

/**
 * The ledger half of a decided shortlist proposal. When the owner
 * denies a load-shortlist proposal, every load on it becomes
 * "skipped" with the reason "owner passed on the shortlist" — that
 * is the outcome the learning reads. When he approves it, nothing
 * is written here: the "booked" row lands when the load is actually
 * booked, via the load flow. Returns how many rows were written.
 * The payload is read defensively — a row that does not parse is
 * counted as missed, never guessed.
 */
export async function recordShortlistDecision(
  store: BotTeamStore,
  proposal: { kind: string; payload: Record<string, unknown> },
  decision: "approved" | "denied",
): Promise<number> {
  if (proposal.kind !== "load-shortlist" || decision !== "denied") return 0;
  const payload = proposal.payload;
  const loads = payload["loads"];
  if (!Array.isArray(loads)) return 0;
  let written = 0;
  for (const raw of loads) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const origin = typeof row["origin"] === "string" ? row["origin"] : null;
    const destination = typeof row["destination"] === "string" ? row["destination"] : null;
    const externalRef = typeof row["externalRef"] === "string" ? row["externalRef"] : null;
    if (!origin || !destination || !externalRef) continue;
    const numberOrNull = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    try {
      await store.recordLoadOutcome({
        loadRef: externalRef,
        brokerName: typeof row["brokerName"] === "string" ? row["brokerName"] : null,
        origin,
        destination,
        rateCentsPerLoadedMile: numberOrNull(row["perLoadedMileCents"]),
        loadedMiles: numberOrNull(row["loadedMiles"]),
        deadheadMiles: numberOrNull(row["deadheadMiles"]),
        payCents: numberOrNull(row["payCents"]),
        outcome: "skipped",
        notes: "Owner passed on the shortlist.",
      });
      written += 1;
    } catch (error) {
      console.error("[bot-team] shortlist decision ledger write failed", error);
    }
  }
  return written;
}

/** Build the default runtime from env (Fly secrets). Tests pass their own. */
export function defaultBrowserRuntime(): BrowserRuntime {
  return createBrowserRuntime();
}
