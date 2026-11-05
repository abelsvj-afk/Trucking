// Deep Research Engine watcher: state law & weight watch (2026-11-02
// design, D-3). Federal Register covers FMCSA; states write the
// weight/size, toll, parking, and emissions rules a driver actually
// gets cited under. Posture: ENACTED bills on tracked categories are
// real signals (magnitude 0.85, hard-fire via triggers.ts);
// introductions are weak signals (0.3) that only feed convergence.
// Coverage v1 is the Southeast/Gulf priority list - his home ground
// and current lanes - polled on a rotation (3 states per tick) to
// respect the free tier; the list is configuration-shaped, and the
// poll message says exactly which states were covered. Without
// OPENSTATES_API_KEY the watcher skips visibly (owner setup item).

import { billIsEnacted, fetchOpenStatesBills, type OpenStatesBill } from "@/services/integrations/openstates";
import type { PressureSignal, Watcher, WatcherResult } from "./types";

export const OPENSTATES_WATCHER_KEY = "openstates";

/** Priority jurisdictions (name -> state code) for v1 coverage. */
export const PRIORITY_STATES: Array<{ name: string; code: string }> = [
  { name: "Florida", code: "FL" },
  { name: "Georgia", code: "GA" },
  { name: "Alabama", code: "AL" },
  { name: "Tennessee", code: "TN" },
  { name: "South Carolina", code: "SC" },
  { name: "North Carolina", code: "NC" },
  { name: "Mississippi", code: "MS" },
  { name: "Louisiana", code: "LA" },
  { name: "Arkansas", code: "AR" },
  { name: "Kentucky", code: "KY" },
  { name: "Virginia", code: "VA" },
  { name: "Texas", code: "TX" },
  { name: "Oklahoma", code: "OK" },
];

export const STATES_PER_TICK = 3;
/**
 * How far back "updated" reaches. Three states per tick over 13 states means a
 * state is revisited only every ~5 ticks, so a 3-day window silently dropped
 * bills updated between visits (and legislatures are mostly out of session
 * this time of year). Signals dedupe on bill id, so a wider window cannot
 * double-count.
 */
export const UPDATED_WINDOW_DAYS = 14;

const CATEGORY_KEYWORDS = [
  "truck",
  "weight",
  "oversize",
  "overweight",
  "toll",
  "parking",
  "emissions",
  "hours of service",
  "commercial vehicle",
  "motor carrier",
];

export function billMatchesCategories(bill: OpenStatesBill): boolean {
  const hay = bill.title.toLowerCase();
  return CATEGORY_KEYWORDS.some((kw) => hay.includes(kw));
}

/** Builds the signal for one tracked bill. Pure - unit-tested. */
export function buildStateLawSignal(
  bill: OpenStatesBill,
  stateCode: string,
  observedAt: string,
): PressureSignal {
  const enacted = billIsEnacted(bill);
  return {
    watcherKey: OPENSTATES_WATCHER_KEY,
    kind: enacted ? "state_law_enacted" : "state_law_introduced",
    topic: "regulation",
    magnitude: enacted ? 0.85 : 0.3,
    summary: enacted
      ? `${stateCode} enacted a tracked trucking bill: "${bill.title}" (${bill.latest_action_description ?? "signed"}).`
      : `${stateCode} introduced a tracked trucking bill: "${bill.title}" - weak signal, watching.`,
    items: [
      {
        title: bill.title,
        url: `https://openstates.org/${stateCode.toLowerCase()}/bills/${encodeURIComponent(bill.id)}/`,
        publishedAt: bill.latest_action_date ?? null,
        summary: bill.latest_action_description ?? null,
      },
    ],
    data: {
      states: [stateCode],
      billId: bill.id,
      enacted,
      latestActionDate: bill.latest_action_date ?? null,
      latestAction: bill.latest_action_description ?? null,
    },
    dedupeKey: `openstates:${bill.id}:${enacted ? "enacted" : "introduced"}`,
    observedAt,
  };
}

export const openStatesWatcher: Watcher = {
  key: OPENSTATES_WATCHER_KEY,
  async poll(state: Record<string, unknown>): Promise<WatcherResult> {
    if (!process.env.OPENSTATES_API_KEY) {
      return {
        watcherKey: OPENSTATES_WATCHER_KEY,
        status: "skipped",
        message:
          "OPENSTATES_API_KEY is not set - state law/weight changes are not being watched. Free key at openstates.org (owner setup item).",
        signals: [],
        state: {},
      };
    }

    const rotation = typeof state.rotation === "number" ? state.rotation : 0;
    const covered: Array<{ name: string; code: string }> = [];
    for (let i = 0; i < STATES_PER_TICK; i++) {
      const jurisdiction = PRIORITY_STATES[(rotation + i) % PRIORITY_STATES.length];
      if (jurisdiction) covered.push(jurisdiction);
    }
    // The API documents updated_since as "a given date" - send a
    // plain YYYY-MM-DD date. The full ISO timestamp with milliseconds
    // this used to send is the prime suspect for the production 400s
    // (2026-11-04 round-2 investigation: the API's OpenAPI spec
    // clears every other param we send, and its auth runs before
    // param validation, so the bad param can't be isolated without
    // the key; the client now surfaces the API's error detail, so if
    // a 400 ever recurs the Research page names the exact cause).
    // Date-only widens the 3-day window by under a day; signals
    // dedupe on bill id, so nothing double-counts.
    const updatedSince = new Date(Date.now() - UPDATED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const observedAt = new Date().toISOString();
    const signals: PressureSignal[] = [];
    const failures: string[] = [];
    let fetched = 0;

    for (const jurisdiction of covered) {
      try {
        const bills = await fetchOpenStatesBills(jurisdiction.name, "truck", updatedSince);
        fetched += bills.length;
        for (const bill of bills) {
          if (billMatchesCategories(bill)) signals.push(buildStateLawSignal(bill, jurisdiction.code, observedAt));
        }
      } catch (err) {
        failures.push(`${jurisdiction.code}: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }

    if (failures.length === covered.length) {
      return {
        watcherKey: OPENSTATES_WATCHER_KEY,
        status: "error",
        message: `All state-law polls failed: ${failures.join("; ")}`,
        signals: [],
        state: {},
      };
    }
    return {
      watcherKey: OPENSTATES_WATCHER_KEY,
      status: "ok",
      message:
        `Covered ${covered.map((c) => c.code).join(", ")} this tick (rotation of ${PRIORITY_STATES.length} priority states). ` +
        `${fetched} bill(s) matched "truck" since ${updatedSince}; ${signals.length} fit a tracked category.` +
        (failures.length > 0 ? ` Failed: ${failures.join("; ")}` : ""),
      signals,
      state: { rotation: (rotation + STATES_PER_TICK) % PRIORITY_STATES.length },
    };
  },
};
