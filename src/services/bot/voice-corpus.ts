// Abel Intelligence Upgrade, Phase E (design §6). Driver-twin
// foundations: the pure machinery over dispatch_exchanges -
// exemplar ranking (what he ACTUALLY sent in similar spots) and
// edit distance (how much he changes Abel's drafts, computed in
// code at capture time). The twin is a consent surface: its own
// capability, driver_twin, default OFF (design §9 decision 4) -
// off means no exemplar injection, no edit tracking, and Abel says
// so when asked. Nothing here retrains anything; the corpus steers
// drafts by example, and the edit-distance trend is the honest
// evidence of whether it's working.

export const DRIVER_TWIN_CAPABILITY = "driver_twin";

/** Normalized Levenshtein distance, 0..1: 0 = identical, 1 = completely different. Word-level (his edits are word swaps more than keystrokes). */
export function editDistanceRatio(a: string, b: string): number {
  const wordsA = a.toLowerCase().split(/\s+/).filter(Boolean);
  const wordsB = b.toLowerCase().split(/\s+/).filter(Boolean);
  if (wordsA.length === 0 && wordsB.length === 0) return 0;
  if (wordsA.length === 0 || wordsB.length === 0) return 1;
  // Classic DP over word sequences, two rows.
  let prev = Array.from({ length: wordsB.length + 1 }, (_, j) => j);
  for (let i = 1; i <= wordsA.length; i++) {
    const cur = [i];
    for (let j = 1; j <= wordsB.length; j++) {
      cur.push(
        Math.min(
          prev[j]! + 1, // delete
          cur[j - 1]! + 1, // insert
          prev[j - 1]! + (wordsA[i - 1] === wordsB[j - 1] ? 0 : 1), // substitute / keep
        ),
      );
    }
    prev = cur;
  }
  return prev[wordsB.length]! / Math.max(wordsA.length, wordsB.length);
}

const TOKEN_STOPWORDS = new Set([
  "the", "and", "for", "you", "that", "this", "with", "have", "will", "your", "from", "they", "them", "then", "than", "what", "when", "just", "que", "los", "las", "una", "con", "por", "para", "esta", "este", "pero", "como",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-záéíóúñü0-9]+/)
      .filter((w) => w.length >= 3 && !TOKEN_STOPWORDS.has(w)),
  );
}

export interface VoiceExemplar {
  exchangeId: string;
  incoming: string;
  actualReply: string;
}

/**
 * Ranks past exchanges by how much their incoming message resembles
 * this one (shared content words, code-counted) and returns the
 * top matches that HAVE an actual sent reply - drafts Abel wrote
 * are never exemplars; only his real sends teach the twin.
 */
export function rankExemplars(
  incoming: string,
  candidates: { id: string; incoming: string; actualReply: string | null }[],
  limit = 3,
): VoiceExemplar[] {
  const needle = tokens(incoming);
  if (needle.size === 0) return [];
  const scored: { ex: VoiceExemplar; score: number }[] = [];
  for (const c of candidates) {
    if (!c.actualReply) continue;
    const hay = tokens(c.incoming);
    let shared = 0;
    for (const w of needle) if (hay.has(w)) shared++;
    if (shared === 0) continue;
    scored.push({
      ex: { exchangeId: c.id, incoming: c.incoming, actualReply: c.actualReply },
      score: shared / Math.max(needle.size, 1),
    });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.ex);
}

/** The context block injected at draft time when the twin is on and exemplars exist. His words, quoted as his - the model drafts toward them. */
export function formatExemplarsBlock(exemplars: VoiceExemplar[]): string | null {
  if (exemplars.length === 0) return null;
  const lines = exemplars.map(
    (ex, i) =>
      `${i + 1}. When dispatch wrote: "${ex.incoming.slice(0, 200)}"\n   He actually sent: "${ex.actualReply.slice(0, 300)}"`,
  );
  return (
    "HOW HE ACTUALLY WRITES (from his real sent replies in similar spots - draft toward HIS voice: his greetings, his directness, his sign-off; these are his words, not templates):\n" +
    lines.join("\n")
  );
}

/** The weekly digest line (design Phase E): the week's draft-edit trend, or null when there's nothing honest to report. */
export function formatTwinDigestLine(stats: { count: number; avgDistance: number | null }): string | null {
  if (stats.count === 0 || stats.avgDistance == null) return null;
  const pct = Math.round(stats.avgDistance * 100);
  return (
    `Driver twin: across ${stats.count} captured repl${stats.count === 1 ? "y" : "ies"} this week, he changed about ${pct}% of my draft words before sending. ` +
    (pct <= 20
      ? "The drafts are landing close to how he writes."
      : pct <= 50
        ? "The drafts still need his hand on them - the corpus keeps learning from every reply he shows me."
        : "He is mostly rewriting my drafts - the twin has a lot to learn yet, and every captured reply teaches it.")
  );
}
