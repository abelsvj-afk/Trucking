// Dispatch Scout shortlist builder — pure, no I/O.
//
// Turns a pile of board loads into the shortlist the owner sees:
// 3–5 loads, each priced, floor-checked, and Auditor-checked, with
// exit warnings attached. Everything that does not qualify is
// reported in `skipped` with a plain-words reason — never silently
// dropped, never padded with unqualified loads to fill the list.
//
// Order of gates, in order:
// 1. Priceable — a load that cannot be priced honestly is skipped
//    with the pricing reason (load-math.ts, never guessed miles).
// 2. Floor — profit per ALL mile must meet the owner's floor.
// 3. Audit — the load must PASS auditLoadDraft (auditor.ts). A
//    failed check blocks the draft from looking clean; it is never
//    silently fixed here. Unverifiable flags (missing windows, flat
//    rate with no per-mile rate) do not fail the audit — the
//    Auditor says "cannot verify", and the shortlist carries that
//    honestly instead of inventing the missing piece.
// 4. Rank — survivors are ranked by profit per ALL mile, then
//    profit per day, then pay; only the top maxShortlist survive.
//
// This module never books, signs, or sends anything. It builds the
// draft the owner approves. tripDays is 1 for every load here:
// ShortlistInput carries no delivery dates yet, so per-day figures
// are a 1-day floor until real windows arrive from the board reader.

import { formatMoney } from "@/lib/money-format";
import { auditLoadDraft, auditSummary } from "./auditor";
import type { BoardLoad } from "./boards";
import { exitWarning, meetsFloor, priceLoad, rankLoads, type PricedLoad } from "./load-math";

export interface ShortlistInput {
  loads: BoardLoad[];
  costPerMileCents: number;
  floorPerAllMileCents: number;
  dieselCentsPerGallon: number;
  mpg: number;
  maxShortlist?: number;
}

export interface ShortlistedLoad {
  priced: PricedLoad;
  auditPassed: boolean;
  warnings: string[];
}

export interface ShortlistResult {
  shortlist: ShortlistedLoad[];
  skipped: { load: BoardLoad; reason: string }[];
}

export function buildShortlist(input: ShortlistInput): ShortlistResult {
  const maxShortlist = input.maxShortlist ?? 5;
  const shortlist: ShortlistedLoad[] = [];
  const skipped: { load: BoardLoad; reason: string }[] = [];
  const survivors: ShortlistedLoad[] = [];

  for (const load of input.loads) {
    const { priced, reason } = priceLoad({
      load,
      costPerMileCents: input.costPerMileCents,
      dieselCentsPerGallon: input.dieselCentsPerGallon,
      mpg: input.mpg,
    });
    if (priced === null) {
      skipped.push({ load, reason: reason ?? "Could not price this load." });
      continue;
    }

    if (!meetsFloor(priced, input.floorPerAllMileCents)) {
      skipped.push({
        load,
        reason: `Below the floor: ${formatMoney(priced.perAllMilesCents)} profit per all mile vs floor ${formatMoney(input.floorPerAllMileCents)} per all mile.`,
      });
      continue;
    }

    const audit = auditLoadDraft({
      rateCentsPerLoadedMile: load.rateCentsPerLoadedMile,
      payCents: priced.payCents,
      loadedMiles: priced.loadedMiles,
      deadheadMiles: priced.deadheadMiles,
      claimedPerLoadedMileCents: priced.perLoadedMileCents,
      claimedPerAllMilesCents: priced.perAllMilesCents,
      pickupWindowStart: load.pickupDate,
    });
    if (!audit.passed) {
      skipped.push({ load, reason: `Auditor check failed: ${auditSummary(audit)}` });
      continue;
    }

    const warning = exitWarning(priced);
    survivors.push({ priced, auditPassed: audit.passed, warnings: warning === null ? [] : [warning] });
  }

  const ranked = rankLoads(survivors.map((entry) => entry.priced));
  const rankedEntries = ranked.map((priced) => {
    const entry = survivors.find((candidate) => candidate.priced === priced);
    if (entry === undefined) throw new Error("Shortlist ranking lost a load — this should never happen.");
    return entry;
  });
  for (const entry of rankedEntries.slice(0, maxShortlist)) {
    shortlist.push(entry);
  }
  for (const entry of rankedEntries.slice(maxShortlist)) {
    skipped.push({
      load: entry.priced.load,
      reason: `Ranked below the top ${maxShortlist} shortlisted loads.`,
    });
  }

  return { shortlist, skipped };
}

/**
 * JSON payload for a bot_proposals row of kind "load-shortlist".
 * Title-ready fields per shortlisted load plus counts. JSON-safe:
 * no undefined, no functions — missing broker/window fields are
 * null, never omitted, so JSON.parse(JSON.stringify(payload))
 * round-trips exactly.
 */
export function shortlistProposalPayload(result: ShortlistResult): Record<string, unknown> {
  return {
    kind: "load-shortlist",
    seen: result.shortlist.length + result.skipped.length,
    shortlisted: result.shortlist.length,
    skipped: result.skipped.length,
    loads: result.shortlist.map(({ priced, auditPassed, warnings }) => {
      const load = priced.load;
      return {
        board: load.boardSlug,
        externalRef: load.externalRef,
        origin: load.origin,
        destination: load.destination,
        pickupDate: load.pickupDate,
        equipment: load.equipment,
        weightLbs: load.weightLbs,
        payCents: priced.payCents,
        pay: formatMoney(priced.payCents),
        loadedMiles: priced.loadedMiles,
        deadheadMiles: priced.deadheadMiles,
        totalMiles: priced.totalMiles,
        perLoadedMileCents: priced.perLoadedMileCents,
        perLoadedMile: formatMoney(priced.perLoadedMileCents),
        perAllMilesCents: priced.perAllMilesCents,
        perAllMile: formatMoney(priced.perAllMilesCents),
        profitCents: priced.profitCents,
        profit: formatMoney(priced.profitCents),
        profitPerDayCents: priced.profitPerDayCents,
        profitPerDay: formatMoney(priced.profitPerDayCents),
        tripDays: priced.tripDays,
        brokerName: load.brokerName,
        brokerCreditScore: load.brokerCreditScore,
        brokerDaysToPay: load.brokerDaysToPay,
        contactRef: load.contactRef,
        auditPassed,
        warnings: [...warnings],
      };
    }),
    skippedReasons: result.skipped.map(({ load, reason }) => ({
      origin: load.origin,
      destination: load.destination,
      reason,
    })),
  };
}
