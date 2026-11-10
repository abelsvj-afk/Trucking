// Home News Banner rotation builder (2026-11-02 design §5): a pure
// function of the GET /api/v1/research-briefings payload, so the
// ordering rules are unit-testable without a DOM and the banner
// component itself stays dumb. The server already filtered the
// payload (briefings: not dismissed; signals: unconsumed, <=72h,
// magnitude >= 0.5) - this module applies the banner's own rules:
// the 14-day briefing window, the class ordering, the signal cap,
// and the rotation cap.

import type {
  ResearchBriefing,
  ResearchDeliveryClass,
  ResearchPageData,
  ResearchSignal,
} from "@/types/entities";

export interface BannerItem {
  kind: "briefing" | "signal";
  id: string;
  topic: string;
  /** Briefing title / signal summary - the headline row. */
  headline: string;
  /** Briefing headline (its one-line summary). Signals have no sub row. */
  sub: string | null;
  /** ISO timestamp the age renders from: briefing created_at / signal observed_at. */
  at: string;
  /** Briefings only: drives the "new" marker. Always false for signals. */
  unread: boolean;
  deliveryClass: ResearchDeliveryClass | null;
  magnitude: number | null;
  /**
   * The story's image, served by OUR endpoints (the browser never loads a
   * publisher URL): signals via /api/v1/news-image?signal=<id>&i=<n>,
   * briefings via /api/v1/briefing-image?briefing=<id>&i=0 (the first
   * finding's cited article). Null when there is no usable image - the
   * banner then shows the branded fallback tile.
   */
  imageSrc: string | null;
}

const BRIEFING_WINDOW_MS = 14 * 24 * 3600 * 1000;
const FRESH_BRIEFING_MS = 72 * 3600 * 1000;
// Phase (a) of docs/design/news-banner-images.md: a deeper queue, but never
// one story or topic taking the whole strip.
const MAX_ITEMS = 12;
const MAX_SIGNALS = 4;
const MAX_PER_TOPIC = 3;

/** "just now" / "25m ago" / "2h ago" / "3d ago" - the banner always shows an age. */
export function formatRelativeAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Math.max(0, now.getTime() - then);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function briefingItem(briefing: ResearchBriefing): BannerItem {
  return {
    kind: "briefing",
    id: briefing.id,
    topic: briefing.topic,
    headline: briefing.title,
    sub: briefing.headline,
    at: briefing.created_at,
    unread: briefing.read_at === null,
    deliveryClass: briefing.delivery_class,
    magnitude: null,
    // Owner ruling 2026-11-10 (news must show images): a briefing's
    // image is the preview image of the article its FIRST finding
    // cites, served by our own endpoint (/api/v1/briefing-image —
    // the same one the Research page uses). A briefing with no
    // findings has no citable article, so it honestly gets no image
    // and the banner renders the branded fallback tile. If the
    // endpoint 404s for that finding, the card's error path renders
    // the same tile — never a publisher URL, never a faked image.
    imageSrc:
      Array.isArray(briefing.findings) && briefing.findings.length > 0
        ? `/api/v1/briefing-image?briefing=${encodeURIComponent(briefing.id)}&i=0`
        : null,
  };
}

/** First item (of the first ten the endpoint will serve) that has a stored image URL. */
function signalImageSrc(signal: ResearchSignal): string | null {
  const items = Array.isArray(signal.items) ? signal.items.slice(0, 10) : [];
  const index = items.findIndex((item) => typeof item?.imageUrl === "string" && item.imageUrl.length > 0);
  return index >= 0 ? `/api/v1/news-image?signal=${encodeURIComponent(signal.id)}&i=${index}` : null;
}

function signalItem(signal: ResearchSignal): BannerItem {
  return {
    kind: "signal",
    id: signal.id,
    topic: signal.topic,
    headline: signal.summary,
    sub: null,
    at: signal.observed_at,
    unread: false,
    deliveryClass: null,
    magnitude: signal.magnitude,
    imageSrc: signalImageSrc(signal),
  };
}

/** Class rank for the merge order (§5): urgent briefings, then fresh signals, then trip, then routine. */
function classRank(item: BannerItem): number {
  if (item.kind === "signal") return 1;
  if (item.deliveryClass === "urgent") return 0;
  if (item.deliveryClass === "trip") return 2;
  return 3;
}

/** Signals order by magnitude x recency: strength discounted by how much of the 72h window has passed. */
function signalScore(item: BannerItem, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - new Date(item.at).getTime());
  const recency = Math.max(0, 1 - ageMs / (72 * 3600 * 1000));
  return (item.magnitude ?? 0) * recency;
}

export function buildBannerItems(
  page: Pick<ResearchPageData, "data" | "signals">,
  now: Date = new Date(),
): BannerItem[] {
  const nowMs = now.getTime();

  const briefings = (page.data ?? [])
    .filter((briefing) => nowMs - new Date(briefing.created_at).getTime() <= BRIEFING_WINDOW_MS)
    .map(briefingItem);
  const signals = (page.signals ?? []).map(signalItem);

  const merged = [...briefings, ...signals].sort((a, b) => {
    const rankDiff = classRank(a) - classRank(b);
    if (rankDiff !== 0) return rankDiff;
    if (a.kind === "signal" && b.kind === "signal") {
      return signalScore(b, nowMs) - signalScore(a, nowMs);
    }
    // Briefings within a class: unread breaks ties upward, then newest first.
    if (a.unread !== b.unread) return a.unread ? -1 : 1;
    return new Date(b.at).getTime() - new Date(a.at).getTime();
  });

  // ONE instance per story (live audit 2026-11-07: the same headline rotated in twice, once as a briefing and once as the
  // signal behind it). Items are already in rank order, so the highest-ranked copy stays. A story matches on its normalised
  // headline OR on a briefing's one-line summary equalling another item's headline.
  const norm = (text: string | null) => (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const seenHeadlines = new Set<string>();
  const summaryAliases = new Set<string>(); // a briefing's one-line summary only ever matches another item's HEADLINE, never another summary
  const unique = merged.filter((item) => {
    const headline = norm(item.headline);
    const summary = norm(item.sub);
    const duplicate = seenHeadlines.has(headline) || summaryAliases.has(headline) || (summary.length > 0 && seenHeadlines.has(summary));
    if (duplicate) return false;
    seenHeadlines.add(headline);
    if (summary.length > 0) summaryAliases.add(summary);
    return true;
  });
  merged.length = 0;
  merged.push(...unique);

  // A fresh briefing (<=72h) leads the rotation when one exists -
  // briefings are the product; signals are the pulse (§5).
  const freshIndex = merged.findIndex(
    (item) => item.kind === "briefing" && nowMs - new Date(item.at).getTime() <= FRESH_BRIEFING_MS,
  );
  if (freshIndex > 0) {
    const [fresh] = merged.splice(freshIndex, 1);
    if (fresh) merged.unshift(fresh);
  }

  // Signal cap applies to the rotation, then the total cap.
  let signalCount = 0;
  const capped = merged.filter((item) => {
    if (item.kind !== "signal") return true;
    signalCount += 1;
    return signalCount <= MAX_SIGNALS;
  });

  const perTopic = new Map<string, number>();
  const spread = capped.filter((item) => {
    const n = (perTopic.get(item.topic) ?? 0) + 1;
    perTopic.set(item.topic, n);
    return n <= MAX_PER_TOPIC;
  });

  return spread.slice(0, MAX_ITEMS);
}
