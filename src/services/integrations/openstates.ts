// OpenStates source for the state-law watcher (2026-11-02 design,
// D-3): free API key from openstates.org. Bills are fetched per
// jurisdiction and classified LOCALLY from each bill's own action
// history (governor:signed / became-law = enacted) rather than
// trusting a server-side filter whose semantics can't be verified
// from here. Response strictly Zod-validated.
//
// ROUND 2 (2026-11-04): production bills polls answered 400 with the
// key verified good, and this client used to throw the body away, so
// the Research page showed a bare "400 Bad Request". The API
// authenticates BEFORE validating params (keyless probing: bogus key
// -> 401 for every param shape), so the failing param can't be
// isolated from outside; the API's `{"detail": ...}` error body is
// now surfaced in the thrown error (the EIA round-1 pattern) so any
// remaining failure names its own cause on the Research page.

import { z } from "zod";

const billSchema = z.object({
  id: z.string(),
  title: z.string(),
  jurisdiction: z.object({ name: z.string() }).optional(),
  latest_action_description: z.string().nullable().optional(),
  latest_action_date: z.string().nullable().optional(),
  actions: z
    .array(
      z.object({
        description: z.string().optional(),
        date: z.string().optional(),
        classification: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

const responseSchema = z.object({
  results: z.array(billSchema),
});

export type OpenStatesBill = z.infer<typeof billSchema>;

export async function fetchOpenStatesBills(
  jurisdictionName: string,
  query: string,
  updatedSince: string,
  fetchFn: typeof fetch = fetch,
): Promise<OpenStatesBill[]> {
  const apiKey = process.env.OPENSTATES_API_KEY;
  if (!apiKey) throw new Error("OPENSTATES_API_KEY is not configured.");
  const url = new URL("https://v3.openstates.org/bills");
  url.searchParams.set("jurisdiction", jurisdictionName);
  url.searchParams.set("q", query);
  url.searchParams.set("updated_since", updatedSince);
  url.searchParams.set("per_page", "20");
  url.searchParams.set("include", "actions");

  const res = await fetchFn(url, {
    headers: { "X-API-Key": apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(
      `OpenStates request for ${jurisdictionName} failed: ${res.status} ${res.statusText}${await openStatesErrorDetail(res)}`,
    );
  }
  const parsed = responseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`OpenStates response didn't match the expected shape: ${parsed.error.message}`);
  }
  return parsed.data.results;
}

const openStatesErrorSchema = z.object({
  detail: z.string(),
});

/**
 * OpenStates explains its own failures in a `{"detail": ...}` body.
 * Surface it; an unreadable or differently-shaped body degrades to
 * the plain status line.
 */
async function openStatesErrorDetail(res: Response): Promise<string> {
  try {
    const parsed = openStatesErrorSchema.safeParse(JSON.parse(await res.text()));
    return parsed.success ? ` (${parsed.data.detail})` : "";
  } catch {
    return "";
  }
}

/** True when any recorded action is a signing / became-law action. */
export function billIsEnacted(bill: OpenStatesBill): boolean {
  return (bill.actions ?? []).some((action) =>
    (action.classification ?? []).some((c) => c === "governor:signed" || c === "became-law" || c === "executive-signature"),
  );
}
