// Deep Research Engine corridor derivation (2026-11-02 design, D-5).
// The corridor is what turns industry research into HIS research:
// the states his next confirmed load runs through. v1 is honestly
// endpoints-only - origin + destination states parsed from the load's
// free-text places; the intermediate interstate states belong to the
// Smart Path lane's route geometry and are NOT guessed here. Loads
// are read read-only through the scoped job pool; the engine never
// writes operational tables.

import type { Queryable } from "@/services/ai/run-industry-briefing";

const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

const VALID_CODES = new Set(Object.values(STATE_CODES));

/** Extract a US state code from a free-text place ("Melbourne, FL", "Atlanta, Georgia", "Dallas TX 75201"). */
export function parseStateCode(place: string | null | undefined): string | null {
  if (!place) return null;
  const text = place.trim();
  const codeMatch = text.match(/,\s*([A-Za-z]{2})\b|\b([A-Za-z]{2})\s+\d{5}(?:-\d{4})?\s*$|\b([A-Za-z]{2})\s*$/);
  const code = (codeMatch?.[1] ?? codeMatch?.[2] ?? codeMatch?.[3])?.toUpperCase();
  if (code && VALID_CODES.has(code)) return code;
  const lower = text.toLowerCase();
  let best: string | null = null;
  let bestLen = 0;
  for (const [name, stateCode] of Object.entries(STATE_CODES)) {
    if (lower.includes(name) && name.length > bestLen) {
      best = stateCode;
      bestLen = name.length;
    }
  }
  return best;
}

export function deriveCorridorStates(origin: string, destination: string): string[] {
  const states = [parseStateCode(origin), parseStateCode(destination)].filter(
    (s): s is string => s !== null,
  );
  return [...new Set(states)];
}

interface LoadRow extends Record<string, unknown> {
  id: string;
  origin: string;
  destination: string;
  pickup_date: string | null;
  delivery_date: string | null;
}

/** Recompute one company's corridor from its next confirmed load. Returns the states (empty when no live load). */
export async function refreshCorridorForCompany(db: Queryable, companyId: string): Promise<string[]> {
  const { rows } = await db.query<LoadRow>(
    `select id, origin, destination, pickup_date, delivery_date
     from loads
     where company_id = $1 and status = 'confirmed' and deleted_at is null
       and (delivery_date is null or delivery_date >= current_date - interval '1 day')
     order by pickup_date asc nulls last, created_at desc
     limit 1`,
    [companyId],
  );
  const load = rows[0];
  if (!load) {
    await db.query(`delete from research_corridor where company_id = $1`, [companyId]);
    return [];
  }
  const states = deriveCorridorStates(load.origin, load.destination);
  await db.query(
    `insert into research_corridor (company_id, load_id, origin_state, destination_state, states, method, trip_start, trip_end, updated_at)
     values ($1, $2, $3, $4, $5, 'endpoints_only', $6, $7, now())
     on conflict (company_id) do update set
       load_id = excluded.load_id,
       origin_state = excluded.origin_state,
       destination_state = excluded.destination_state,
       states = excluded.states,
       method = excluded.method,
       trip_start = excluded.trip_start,
       trip_end = excluded.trip_end,
       updated_at = now()`,
    [
      companyId,
      load.id,
      parseStateCode(load.origin),
      parseStateCode(load.destination),
      states,
      load.pickup_date,
      load.delivery_date,
    ],
  );
  return states;
}

export async function refreshCorridors(db: Queryable, companyIds: string[]): Promise<void> {
  for (const companyId of companyIds) {
    try {
      await refreshCorridorForCompany(db, companyId);
    } catch (err) {
      // A corridor failure degrades escalation, never the tick.
      console.error("[research] corridor refresh failed", companyId, err);
    }
  }
}

export async function loadCorridorStates(db: Queryable, companyId: string): Promise<string[]> {
  const { rows } = await db.query<{ states: string[] } & Record<string, unknown>>(
    `select states from research_corridor where company_id = $1`,
    [companyId],
  );
  return rows[0]?.states ?? [];
}
