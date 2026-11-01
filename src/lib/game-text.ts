// Gaming System text discipline (docs/design/gaming-system.md §5):
// the diff between plan versions is computed by CODE (§4.2 - never a
// silent overwrite, never a model-invented change list), checkpoint
// verdicts are arithmetic, and every piece of model narration passes
// the banned-phrase + grounded-figure checks before a plan may be
// stored as current. Pure functions, unit-tested like the engine.

import type { AssumptionEntry, GameOutput } from "./game-plan";
import { formatDollars } from "./truck-fund";

// ---------------------------------------------------------------------------
// Banned phrases (design §5.2) - no revenue promises, ever. The
// target is HIS aim; the app's job is the map, and the map shows
// terrain, not destiny.
// ---------------------------------------------------------------------------

export const BANNED_PLAN_PHRASES = [
  "guaranteed",
  "guarantee",
  "will make",
  "locked in",
  "sure thing",
  "risk-free",
  "risk free",
  "can't lose",
  "cannot lose",
  "promise you",
] as const;

export function findBannedPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_PLAN_PHRASES.filter((phrase) => lower.includes(phrase));
}

// ---------------------------------------------------------------------------
// Grounded figures (design §5.3) - every dollar figure in a narration
// must trace to the frozen snapshot, the assumption sheet, or engine
// arithmetic on those two. Dollar figures in text are compared at
// whole-dollar precision (narration rounds cents away).
// ---------------------------------------------------------------------------

export function extractDollarFiguresCents(text: string): number[] {
  const figures: number[] = [];
  const pattern = /\$\s?([\d,]+(?:\.\d{2})?)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) != null) {
    const value = Number(match[1]!.replace(/,/g, ""));
    if (Number.isFinite(value)) figures.push(Math.round(value * 100));
  }
  return figures;
}

function collectCents(value: unknown, into: Set<number>): void {
  if (typeof value === "number") return;
  if (Array.isArray(value)) {
    for (const item of value) collectCents(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === "number" && /cents$/i.test(key)) {
        into.add(Math.round(item / 100) * 100);
      } else {
        collectCents(item, into);
      }
    }
  }
}

/** The whole-dollar figure set a narration is allowed to use. */
export function allowedFigureSet(sources: unknown[]): Set<number> {
  const set = new Set<number>();
  for (const source of sources) collectCents(source, set);
  return set;
}

export function findUngroundedFigures(text: string, allowed: Set<number>): number[] {
  return extractDollarFiguresCents(text).filter((cents) => !allowed.has(cents));
}

// ---------------------------------------------------------------------------
// The diff (design §4.2) - code-first comparison between the previous
// current plan and the new one, narrated as one short paragraph of
// code-assembled text. Shape per the spec's own example:
// "Plan v7 (was v6). Changed because: ... Truck window: Jun -> May.
//  Gap at target date: -$12,400 -> -$9,150. New lever needed: none."
// ---------------------------------------------------------------------------

export interface StoredPlanShape {
  version: number;
  trigger: string;
  assumptions: AssumptionEntry[];
  scenarios: GameOutput;
}

export interface PlanDiff {
  previousVersion: number | null;
  gapBeforeCents: number | null;
  gapAfterCents: number;
  gapDeltaCents: number | null;
  truckWindowBefore: string | null;
  truckWindowAfter: string | null;
  authorityBefore: string | null;
  authorityAfter: string | null;
  assumptionChanges: { key: string; from: unknown; to: unknown }[];
  material: boolean;
  text: string;
}

const TRIGGER_LABELS: Record<string, string> = {
  target_set: "you set the target",
  target_edit: "you edited the target",
  checkpoint: "the monthly checkpoint closed",
  settlement: "new settlements landed",
  fund_milestone: "the Truck Fund crossed a milestone",
  research_briefing: "a research briefing landed",
  maintenance_event: "a big maintenance event landed",
  manual: "you asked for a re-game",
  what_if: "a what-if",
};

function signedDollars(cents: number): string {
  return cents < 0 ? `-${formatDollars(-cents)}` : formatDollars(cents);
}

export function computePlanDiff(input: {
  previous: StoredPlanShape | null;
  nextVersion: number;
  next: GameOutput;
  nextAssumptions: AssumptionEntry[];
  trigger: string;
  materialityPct: number;
  targetChanged: boolean;
}): PlanDiff {
  const { previous, next, trigger } = input;
  const gapAfter = -next.scenarios.recommended.shortfallCents; // negative = short
  const truckAfter = next.scenarios.recommended.milestones.truckWindowMonth;
  const authorityAfter = next.scenarios.recommended.milestones.authorityMonth;

  if (!previous) {
    return {
      previousVersion: null,
      gapBeforeCents: null,
      gapAfterCents: gapAfter,
      gapDeltaCents: null,
      truckWindowBefore: null,
      truckWindowAfter: truckAfter,
      authorityBefore: null,
      authorityAfter,
      assumptionChanges: [],
      material: true,
      text: `Plan v${input.nextVersion}. First plan for this target. Gap at the target date: ${signedDollars(gapAfter)} on the recommended path (a projection, not a promise).`,
    };
  }

  const gapBefore = -previous.scenarios.scenarios.recommended.shortfallCents;
  const gapDelta = gapAfter - gapBefore;
  const truckBefore = previous.scenarios.scenarios.recommended.milestones.truckWindowMonth;
  const authorityBefore = previous.scenarios.scenarios.recommended.milestones.authorityMonth;

  const prevAssumptions = new Map(previous.assumptions.map((a) => [a.key, a.value]));
  const assumptionChanges: { key: string; from: unknown; to: unknown }[] = [];
  for (const entry of input.nextAssumptions) {
    const from = prevAssumptions.get(entry.key);
    if (JSON.stringify(from) !== JSON.stringify(entry.value)) {
      assumptionChanges.push({ key: entry.key, from, to: entry.value });
    }
  }

  const material =
    input.targetChanged ||
    truckBefore !== truckAfter ||
    authorityBefore !== authorityAfter ||
    Math.abs(gapDelta) >= Math.round((input.materialityPct / 100) * Math.max(1, next.gap.targetCents));

  const parts = [
    `Plan v${input.nextVersion} (was v${previous.version}).`,
    `Changed because: ${TRIGGER_LABELS[trigger] ?? trigger}.`,
    `Truck window: ${truckBefore ?? "none in horizon"} -> ${truckAfter ?? "none in horizon"}.`,
    `Gap at target date: ${signedDollars(gapBefore)} -> ${signedDollars(gapAfter)} (projection).`,
  ];
  if (assumptionChanges.length > 0) {
    parts.push(`Assumptions changed: ${assumptionChanges.map((c) => c.key).join(", ")}.`);
  }

  return {
    previousVersion: previous.version,
    gapBeforeCents: gapBefore,
    gapAfterCents: gapAfter,
    gapDeltaCents: gapDelta,
    truckWindowBefore: truckBefore,
    truckWindowAfter: truckAfter,
    authorityBefore,
    authorityAfter,
    assumptionChanges,
    material,
    text: parts.join(" "),
  };
}

// ---------------------------------------------------------------------------
// Checkpoints (design §4.3) - verdicts are arithmetic; the digest is
// one message, plain first, information only, never an action.
// ---------------------------------------------------------------------------

export type CheckpointVerdict = "on_plan" | "ahead" | "behind" | "no_data";

export function checkpointVerdict(input: {
  plannedCents: number;
  actualCents: number | null;
  hasRecords: boolean;
}): CheckpointVerdict {
  if (!input.hasRecords || input.actualCents == null) return "no_data";
  const band = Math.round(Math.abs(input.plannedCents) * 0.02);
  if (input.actualCents > input.plannedCents + band) return "ahead";
  if (input.actualCents < input.plannedCents - band) return "behind";
  return "on_plan";
}

export function buildCheckpointDigest(input: {
  monthLabel: string; // e.g. "October"
  planVersion: number;
  metricLabel: string;
  verdict: CheckpointVerdict;
  gapCents: number | null; // actual - planned
  causeLine: string;
  truckWindowMonth: string | null;
  leverNote: string;
}): string {
  const verdictText =
    input.verdict === "no_data"
      ? "no records landed this month, so there's nothing to grade - the plan can't steer on an empty month"
      : input.verdict === "ahead"
        ? `ahead by ${formatDollars(Math.abs(input.gapCents ?? 0))} on ${input.metricLabel.toLowerCase()}`
        : input.verdict === "behind"
          ? `behind by ${formatDollars(Math.abs(input.gapCents ?? 0))} on ${input.metricLabel.toLowerCase()}`
          : `on plan on ${input.metricLabel.toLowerCase()}`;
  const lines = [
    `${input.monthLabel} checkpoint - Plan v${input.planVersion}. Verdict: ${verdictText}.`,
    `Cause in one line: ${input.causeLine}`,
  ];
  if (input.truckWindowMonth) lines.push(`Truck window still ${input.truckWindowMonth} (projection).`);
  lines.push(`Your lever for next month: ${input.leverNote}`);
  lines.push("Full plan: app -> More -> Game Plan.");
  return lines.join("\n");
}
