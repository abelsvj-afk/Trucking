// WZDx work-zone feed registry (docs/design/smart-path-intelligence.md §3).
// EMPTY ON PURPOSE: a feed URL is a fact that must be checked (it exists, it is
// WZDx, it is reachable from the deploy network, its terms allow this use). Add one
// row per state ONLY after that check, and say who checked it. A crossed state with
// no row is reported as "no work-zone data for <state>" - absence of data is never
// absence of work zones.

export interface WzdxFeed {
  state: string;
  url: string;
  /** Who verified the feed and on what date, e.g. "King 2026-11-06". */
  verifiedBy: string;
}

export const WZDX_FEEDS: WzdxFeed[] = [];
