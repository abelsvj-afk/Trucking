// Research errors, in words an owner can read (live audit 2026-11-07: the Research tab printed raw provider/HTTP strings,
// stack-like fragments and JSON). Known failure shapes map to one plain sentence; anything else is stripped of URLs, JSON and
// stack lines and capped, never shown raw. Pure.

const PATTERNS: [RegExp, string][] = [
  [/\b403\b|forbidden/i, "The source refused our request (it blocks automated readers)."],
  [/\b401\b|unauthori[sz]ed|invalid api key|incorrect api key/i, "The source rejected our login or key."],
  [/\b404\b|not found/i, "The source address no longer exists."],
  [/\b429\b|rate limit|too many requests|quota/i, "The source asked us to slow down (rate limit) — it will retry."],
  [/\b5\d\d\b|bad gateway|service unavailable|gateway time/i, "The source had a server problem on its end."],
  [/timed? ?out|etimedout|econnreset|econnrefused|enotfound|getaddrinfo|socket hang up|network/i, "Couldn't reach the source (network problem)."],
  [/certificate|ssl|tls/i, "The source's security certificate was refused."],
  [/parse|unexpected token|invalid json|xml|malformed/i, "The source answered in a format we couldn't read."],
  [/cap|budget|limit reached|max runs/i, "Stopped by the daily or monthly run limit (by design)."],
];

export function cleanResearchError(raw: string | null | undefined): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  for (const [pattern, words] of PATTERNS) if (pattern.test(text)) return words;
  const stripped = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\{[\s\S]*\}/g, "")
    .replace(/\bat\s+\S+\s*\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return stripped ? `${stripped}${text.length > 140 ? "…" : ""}` : "A source reported a problem.";
}
