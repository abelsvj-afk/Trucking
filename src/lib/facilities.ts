// GAP-03 (Fresh-Eyes Register 2026-11-02) — facility memory.
//
// Places are matched the way a driver names them: case, spacing,
// and punctuation don't matter; the name plus city is the identity.
// Matching is deliberately conservative — an exact normalized
// name+city hit or nothing. A near-miss creates a proposal (via
// Abel), never a silent merge of two different yards.

export function normalizePlaceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface FacilityLike {
  id: string;
  name: string;
  city: string | null;
}

/** The identity key for a place: normalized name + normalized city. */
export function facilityKey(name: string, city?: string | null): string {
  return `${normalizePlaceText(name)}|${normalizePlaceText(city ?? "")}`;
}

export function matchFacility<T extends FacilityLike>(
  facilities: T[],
  name: string,
  city?: string | null,
): T | null {
  const key = facilityKey(name, city);
  return facilities.find((f) => facilityKey(f.name, f.city) === key) ?? null;
}

/**
 * Splits a free-text load origin/destination ("Tyson Foods,
 * Wildwood FL") into a probable facility name + city/state tail.
 * Heuristic and labeled as such: the last comma segment is treated
 * as the place tail; without a comma the whole string is the name.
 */
export function splitPlaceText(text: string): { name: string; city: string | null; state: string | null } {
  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { name: text.trim(), city: null, state: null };
  const tail = parts[parts.length - 1]!;
  const stateMatch = tail.match(/\b([A-Z]{2})\b\s*$/);
  const state = stateMatch ? stateMatch[1]! : null;
  const city = state ? tail.replace(/\b[A-Z]{2}\b\s*$/, "").trim() || null : tail;
  return { name: parts.slice(0, -1).join(", "), city, state };
}
