// Dispatch Scout load boards (Phase 1; plan docs/bot-team-build-plan.md).
// The ranked board list, the per-board normalizers, and the fallback
// walker that reads the boards in order. This module is pure logic
// plus one injected reader — no network, no browser, no database —
// so the tests can prove the ranking, the normalizing, and the
// fallback without ever touching a live board.
//
// The hard rule, from the Scout's governing file
// (docs/bots/dispatch-scout/CLAUDE.md) and the board research
// (research_notes/free-load-boards-dispatch-bot-testing-20261119-1921):
// a field the board does not give stays null. Miles, rates, and
// broker data are NEVER guessed. A load with no origin or no
// destination is not a load — it is dropped with a plain-words
// reason, never silently kept and never invented.
//
// Money is integer cents. Rates the board quotes as a flat total
// stay a flat total; a per-mile figure is carried ONLY when the
// board quoted one. A per-mile figure is NEVER derived from a flat
// total: rounding rate / miles introduces up to 0.5c/mi error, and
// on a long haul the Auditor's recomputation (rate x miles vs flat
// pay, $1.00 tolerance) can then disagree by more than $1 and drop
// a real load as auditor-failing. The Auditor already handles the
// flat-total case as "unverifiable rate" rather than an error, and
// load math prices from the flat total directly — so null here is
// correct, not missing data.

import type { BoardReadResult } from "./browser-runtime";

export type BoardSlug = "trulos" | "trucker-path" | "justtracking";

export interface BoardDescriptor {
  slug: BoardSlug;
  name: string;
  url: string;
  requiresAuth: boolean;
  freeTier: string;
  notes: string;
  cloudflareRisk: boolean;
}

/**
 * The free boards, in the ranked order the Scout reads them. The
 * ranking and the notes come from the 2026-11-19 board research:
 * TruLOS first because it needs no login at all; Trucker Path
 * second for the biggest free pool; JustTracking third because it
 * shows broker credit and days-to-pay on every load, but is the
 * least independently verified of the three.
 */
export const FREE_BOARDS: BoardDescriptor[] = [
  {
    slug: "trulos",
    name: "TruLOS",
    url: "https://trulos.com/load-board",
    requiresAuth: false,
    freeTier: "Free, no login or signup at all. Ad-supported since 2006.",
    notes:
      "Live table with pickup date, origin, destination, equipment, rate, weight. " +
      "No miles column in the table — route and miles live inside each load's Details panel. " +
      "Some rates are $0, which means call-for-rate, not a $0 load. " +
      "Thinner pool than the big paid boards. A Cloudflare human-check was observed on the live site on 2026-11-19.",
    cloudflareRisk: true,
  },
  {
    slug: "trucker-path",
    name: "Trucker Path TruckLoads",
    url: "https://loadboard.truckerpath.com",
    requiresAuth: true,
    freeTier: "Free tier: search loads and contact brokers at no cost, web and app. Biggest free pool claimed (150,000+ loads/day).",
    notes:
      "Rates appear only where the broker shared them. Broker credit, days-to-pay, and rate checks are paywalled " +
      "($29.99–$49.99/month). The free view cap is disputed: the official page says free unlimited, the paid tiers sell " +
      "unlimited views, and one October 2026 review says 5 loads a day free. No Cloudflare block was observed — " +
      "that is unproven, not a promise.",
    cloudflareRisk: false,
  },
  {
    slug: "justtracking",
    name: "JustTracking",
    url: "https://justtracking.net",
    requiresAuth: true,
    freeTier: "Free, no card. Explicitly no authority needed to start. 250,000+ loads/day claimed.",
    notes:
      "Every load purportedly shows broker credit score, days-to-pay, and minimum authority age — the exact fields " +
      "a profit-and-risk check needs. Newest and least independently verified of the three: per-load depth " +
      "(miles, weight, dates) and whether the homepage sample loads are live were not confirmed from public pages. " +
      "No Cloudflare block was observed — that is unproven, not a promise.",
    cloudflareRisk: false,
  },
];

/**
 * Boards that are listed, never read. Paid boards join only when the
 * owner subscribes; broker apps join only when his own authority is
 * active. The walker never touches this list — it exists so the
 * Scout's shortlist can say plainly what it did NOT check, and why.
 */
export const LATER_BOARDS: { slug: string; name: string; blockedBy: string }[] = [
  { slug: "dat", name: "DAT One", blockedBy: "paid subscription — owner adds later" },
  { slug: "truckstop", name: "Truckstop", blockedBy: "paid subscription — owner adds later" },
  { slug: "123loadboard", name: "123Loadboard", blockedBy: "paid subscription — owner adds later" },
  { slug: "trucksmarter", name: "TruckSmarter", blockedBy: "active MC authority — owner adds later" },
  { slug: "uber-freight", name: "Uber Freight", blockedBy: "active MC authority — owner adds later" },
  { slug: "amazon-relay", name: "Amazon Relay", blockedBy: "active MC authority — owner adds later" },
  { slug: "ch-robinson", name: "C.H. Robinson", blockedBy: "active MC authority — owner adds later" },
  { slug: "loadsmart", name: "Loadsmart", blockedBy: "active MC authority — owner adds later" },
];

export interface BoardLoad {
  boardSlug: BoardSlug;
  externalRef: string;
  origin: string;
  destination: string;
  pickupDate: string | null;
  equipment: string | null;
  /** Flat total pay for the load, in cents. Null when the board did not give a rate. */
  rateCents: number | null;
  /** Cents per loaded mile. Only ever the board's own quoted per-mile rate — never derived from a flat total (see the header note). Null when the board quoted a flat total or no rate. */
  rateCentsPerLoadedMile: number | null;
  weightLbs: number | null;
  loadedMiles: number | null;
  deadheadMiles: number | null;
  brokerName: string | null;
  brokerCreditScore: number | null;
  brokerDaysToPay: number | null;
  contactRef: string | null;
  rawNote: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[^0-9.]/g, ""));
      if (value.trim().length > 0 && Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * "$1,850" -> 185000 cents. A number is read as dollars. Zero or
 * less means no rate was given (TruLOS shows $0 for call-for-rate),
 * so it comes back null — a $0 load does not exist.
 */
function dollarsToCents(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.round(value * 100);
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,\s]/g, "");
    if (cleaned.length === 0) return null;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed * 100);
  }
  return null;
}

/** "$2.10/mi" or a plain per-mile number (dollars) -> cents per mile. */
function perMileToCents(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.round(value * 100);
  }
  if (typeof value === "string") {
    if (!value.includes("/mi") && !value.toLowerCase().includes("per mile")) return null;
    return dollarsToCents(value.replace(/\/mi/gi, "").replace(/per mile/gi, ""));
  }
  return null;
}

/** Small deterministic hash (FNV-1a) for a stable externalRef when the board gives no id. */
function hashRef(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isPerMileRate(value: unknown): boolean {
  return typeof value === "string" && (value.includes("/mi") || value.toLowerCase().includes("per mile"));
}

/**
 * Normalize one raw row from the browser worker into a BoardLoad.
 * A field the row does not give stays null — never guessed. A row
 * with no origin or no destination is not a load: it returns null
 * with a plain-words reason.
 */
export function normalizeBoardLoad(boardSlug: BoardSlug, raw: unknown): { load: BoardLoad | null; reason: string | null } {
  if (!isRecord(raw)) {
    return { load: null, reason: "This row is not a load — the board sent back something this app cannot read, so the row was skipped." };
  }
  const origin = firstString(raw, ["origin", "from", "pickupCity", "pickup_city", "originCity"]);
  const destination = firstString(raw, ["destination", "to", "deliveryCity", "delivery_city", "destinationCity", "dest"]);
  if (!origin || !destination) {
    const missing = !origin && !destination ? "origin and destination" : !origin ? "origin" : "destination";
    return { load: null, reason: `This load has no ${missing}, so it cannot be used — a load without both ends is not a load. The row was skipped.` };
  }

  const rateValue = raw.rate ?? raw.totalRate ?? raw.flatRate ?? raw.pay ?? null;
  const perMileValue = raw.ratePerMile ?? raw.ratePerLoadedMile ?? raw.perMile ?? raw.rate_cents_per_loaded_mile ?? null;
  const rateCents = isPerMileRate(rateValue) ? null : dollarsToCents(rateValue);
  let rateCentsPerLoadedMile = perMileToCents(perMileValue);
  if (rateCentsPerLoadedMile === null && isPerMileRate(rateValue)) {
    rateCentsPerLoadedMile = perMileToCents(rateValue);
  }
  const loadedMiles = firstNumber(raw, ["loadedMiles", "loaded_miles", "miles", "distance", "loadedDistance"]);

  const pickupDate = firstString(raw, ["pickupDate", "pickup_date", "date", "pickup", "availableDate"]);
  const boardId = firstString(raw, ["id", "externalRef", "loadId", "ref"]);
  const externalRef =
    boardId !== null ? `${boardSlug}:${boardId}` : `${boardSlug}:${hashRef(`${origin}|${destination}|${pickupDate ?? ""}|${rateCents ?? ""}`)}`;

  return {
    load: {
      boardSlug,
      externalRef,
      origin,
      destination,
      pickupDate,
      equipment: firstString(raw, ["equipment", "trailerType", "trailer", "equip"]),
      rateCents,
      rateCentsPerLoadedMile,
      weightLbs: firstNumber(raw, ["weight", "weightLbs", "weight_lbs", "lbs"]),
      loadedMiles,
      deadheadMiles: firstNumber(raw, ["deadheadMiles", "deadhead_miles", "deadhead"]),
      brokerName: firstString(raw, ["brokerName", "broker", "broker_name", "company"]),
      brokerCreditScore: firstNumber(raw, ["brokerCreditScore", "broker_credit_score", "creditScore", "brokerCredit"]),
      brokerDaysToPay: firstNumber(raw, ["brokerDaysToPay", "daysToPay", "broker_days_to_pay", "days_to_pay"]),
      contactRef: firstString(raw, ["contactRef", "contact", "phone", "brokerContact"]),
      rawNote: firstString(raw, ["rawNote", "details", "note", "f_p", "fp"]),
    },
    reason: null,
  };
}

export interface BoardReport {
  boardSlug: BoardSlug;
  status: string;
  loadsSeen: number;
  note: string;
}

export interface WalkBoardsOptions {
  /** Cap on how many boards the walk attempts. Defaults to the whole free list. */
  maxBoards?: number;
  /** Stop after the first board that returns usable loads. Default: walk every board and report everything. */
  stopAfterFirstUsable?: boolean;
}

/**
 * Walk FREE_BOARDS in ranked order, normalizing each board's raw
 * rows into loads and reporting per board. A board that is blocked,
 * errors, or comes back empty contributes a report entry and the
 * walk CONTINUES to the next board — the fallback is the point.
 * Human-pace gaps between reads are the caller's job, using
 * HUMAN_PACE from services/bots/browser-runtime.ts. The reader
 * itself must never throw for a failed read; if it does anyway, the
 * failure is reported here and the walk continues.
 */
export async function walkBoards(
  reader: (board: BoardDescriptor) => Promise<BoardReadResult>,
  opts: WalkBoardsOptions = {},
): Promise<{ loads: BoardLoad[]; boardReports: BoardReport[] }> {
  const maxBoards = opts.maxBoards ?? FREE_BOARDS.length;
  const boards = FREE_BOARDS.slice(0, Math.max(0, maxBoards));
  const loads: BoardLoad[] = [];
  const boardReports: BoardReport[] = [];

  for (const board of boards) {
    let result: BoardReadResult;
    try {
      result = await reader(board);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      boardReports.push({
        boardSlug: board.slug,
        status: "error",
        loadsSeen: 0,
        note: `Reading ${board.name} failed (${reason}) — no loads were read from this board.`,
      });
      continue;
    }

    if (result.status !== "ok") {
      boardReports.push({
        boardSlug: board.slug,
        status: result.status,
        loadsSeen: 0,
        note: result.note,
      });
      continue;
    }

    let usable = 0;
    let skipped = 0;
    for (const raw of result.loads) {
      const { load } = normalizeBoardLoad(board.slug, raw);
      if (load !== null) {
        loads.push(load);
        usable += 1;
      } else {
        skipped += 1;
      }
    }
    boardReports.push({
      boardSlug: board.slug,
      status: "ok",
      loadsSeen: usable,
      note:
        usable > 0
          ? `${board.name} gave ${usable} usable load${usable === 1 ? "" : "s"}${skipped > 0 ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped: no origin or destination)` : ""}.`
          : `${board.name} gave no usable loads${skipped > 0 ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped: no origin or destination)` : ""}.`,
    });

    if (opts.stopAfterFirstUsable === true && usable > 0) break;
  }

  return { loads, boardReports };
}
