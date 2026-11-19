// Dispatch Scout preference learning — pure, reads rows, never writes.
//
// Learns what the owner likes from the load ledger (bot_load_ledger
// rows: booked / skipped / cancelled / completed / disputed) so the
// next shortlist fits him better. This only LEARNS. Nothing here
// auto-applies: a suggested floor is a suggestion, and applying it
// is always the owner's tap.
//
// Honest limits:
// - hasEnoughData needs at least 3 booked loads. Below that,
//   suggestedFloorCents stays null — a floor is never invented
//   from thin data.
// - $ per ALL mile is pay / (loaded + deadhead), rounded the same
//   way the Auditor rounds per-mile figures. Booked rows missing
//   pay or miles are left out of the floor math, never guessed.
// - Skip reasons come from the notes field: the phrase before
//   " — " when the note has one, else the whole note when it is
//   short. A long note with no separator carries no extractable
//   reason phrase and is not counted.
// - Lanes need both an origin and a destination; rows missing
//   either do not count toward preferred lanes.

export interface LedgerRowLike {
  load_ref: string;
  broker_name: string | null;
  origin: string | null;
  destination: string | null;
  rate_cents_per_loaded_mile: number | null;
  loaded_miles: number | null;
  deadhead_miles: number | null;
  pay_cents: number | null;
  fuel_cents: number | null;
  outcome: "booked" | "skipped" | "cancelled" | "completed" | "disputed";
  notes: string | null;
}

export interface LearnedPreferences {
  bookedCount: number;
  skippedCount: number;
  hasEnoughData: boolean;
  minBookedPerAllMileCents: number | null;
  preferredLanes: { origin: string; destination: string; bookedCount: number }[];
  commonSkipReasons: { reason: string; count: number }[];
  suggestedFloorCents: number | null;
}

const MIN_BOOKED_FOR_FLOOR = 3;
const MAX_LANES = 5;
const MAX_SKIP_REASONS = 5;
/** A note with no " — " separator only counts as a reason when it is this short or shorter. */
const MAX_WHOLE_NOTE_REASON_LENGTH = 100;

/** $ per ALL mile, Auditor rounding. Null when the row cannot support the figure. */
function perAllMileCents(row: LedgerRowLike): number | null {
  if (row.pay_cents === null || row.loaded_miles === null || row.deadhead_miles === null) return null;
  const totalMiles = row.loaded_miles + row.deadhead_miles;
  if (totalMiles <= 0) return null;
  return Math.round((row.pay_cents / totalMiles) * 100) / 100;
}

/** The reason phrase in a skip note: before " — ", or the whole short note. Null when none can be read. */
function skipReason(notes: string | null): string | null {
  if (notes === null) return null;
  const trimmed = notes.trim();
  if (trimmed === "") return null;
  const separator = trimmed.indexOf(" — ");
  if (separator !== -1) {
    const phrase = trimmed.slice(0, separator).trim();
    return phrase === "" ? null : phrase;
  }
  if (trimmed.length > MAX_WHOLE_NOTE_REASON_LENGTH) return null;
  return trimmed;
}

export function learnPreferences(rows: LedgerRowLike[]): LearnedPreferences {
  const booked = rows.filter((row) => row.outcome === "booked");
  const skipped = rows.filter((row) => row.outcome === "skipped");
  const bookedCount = booked.length;
  const skippedCount = skipped.length;
  const hasEnoughData = bookedCount >= MIN_BOOKED_FOR_FLOOR;

  let minBookedPerAllMileCents: number | null = null;
  for (const row of booked) {
    const perAll = perAllMileCents(row);
    if (perAll === null) continue;
    if (minBookedPerAllMileCents === null || perAll < minBookedPerAllMileCents) {
      minBookedPerAllMileCents = perAll;
    }
  }

  const laneCounts = new Map<string, { origin: string; destination: string; bookedCount: number }>();
  for (const row of booked) {
    if (row.origin === null || row.destination === null) continue;
    const origin = row.origin.trim();
    const destination = row.destination.trim();
    if (origin === "" || destination === "") continue;
    const key = `${origin} -> ${destination}`;
    const existing = laneCounts.get(key);
    if (existing === undefined) {
      laneCounts.set(key, { origin, destination, bookedCount: 1 });
    } else {
      existing.bookedCount += 1;
    }
  }
  const preferredLanes = [...laneCounts.values()]
    .sort((a, b) => b.bookedCount - a.bookedCount)
    .slice(0, MAX_LANES);

  const reasonCounts = new Map<string, number>();
  for (const row of skipped) {
    const reason = skipReason(row.notes);
    if (reason === null) continue;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const commonSkipReasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_SKIP_REASONS);

  return {
    bookedCount,
    skippedCount,
    hasEnoughData,
    minBookedPerAllMileCents,
    preferredLanes,
    commonSkipReasons,
    suggestedFloorCents: hasEnoughData ? minBookedPerAllMileCents : null,
  };
}
