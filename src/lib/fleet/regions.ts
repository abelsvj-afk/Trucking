// US regions for fleet learning and load recommendations (docs/design/fleet-learning-and-driver-questions.md section 3).
// Pure. A driver's preferences are usually about regions ("not the Northeast"), so loads are bucketed by the region
// of their destination state. Region ids are lower-case words; states are 2-letter codes.

export const REGIONS = {
  northeast: ["CT", "ME", "MA", "NH", "RI", "VT", "NJ", "NY", "PA"],
  southeast: ["DE", "MD", "DC", "VA", "WV", "NC", "SC", "GA", "FL", "AL", "MS", "TN", "KY", "AR", "LA"],
  midwest: ["OH", "IN", "IL", "MI", "WI", "MN", "IA", "MO", "ND", "SD", "NE", "KS"],
  southwest: ["TX", "OK", "NM", "AZ"],
  mountain: ["MT", "ID", "WY", "NV", "UT", "CO"],
  pacific: ["WA", "OR", "CA", "AK", "HI"],
} as const;

export type RegionId = keyof typeof REGIONS;
export const REGION_IDS = Object.keys(REGIONS) as RegionId[];

const STATE_TO_REGION = new Map<string, RegionId>(
  (Object.entries(REGIONS) as [RegionId, readonly string[]][]).flatMap(([region, states]) => states.map((s) => [s, region] as const)),
);

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

/** "FL", "fl", "Florida" -> "FL"; anything else -> null. */
export function normalizeState(input: string | null | undefined): string | null {
  const t = String(input ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/^[a-z]{2}$/.test(t) && STATE_TO_REGION.has(t.toUpperCase())) return t.toUpperCase();
  return STATE_NAMES[t] ?? null;
}

export function regionOfState(state: string | null | undefined): RegionId | null {
  const s = normalizeState(state);
  return s ? STATE_TO_REGION.get(s) ?? null : null;
}

/**
 * A place he named ("northeast", "the South", "Florida", "FL") as a normalised region id or state code.
 * "the south" is read as the southeast; anything it cannot place is null (never guessed).
 */
export function normalizePlace(input: string): RegionId | string | null {
  const t = String(input ?? "").trim().toLowerCase().replace(/^the /, "");
  if ((REGION_IDS as string[]).includes(t)) return t as RegionId;
  if (t === "south") return "southeast";
  if (t === "west" || t === "west coast") return "pacific";
  if (t === "east coast" || t === "new england") return "northeast";
  if (t === "midatlantic" || t === "mid-atlantic") return "northeast";
  return normalizeState(t);
}

/** Does `state` fall inside the named place (a region id or a state code)? */
export function stateInPlace(state: string | null | undefined, place: string): boolean {
  const s = normalizeState(state);
  if (!s) return false;
  return (REGION_IDS as string[]).includes(place) ? regionOfState(s) === place : s === place.toUpperCase();
}
