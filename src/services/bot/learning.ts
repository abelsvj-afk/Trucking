// Learning from his answers (owner approved 2026-11-07; docs/design/bot-messages-and-safety.md section 6).
// Pure. No model is trained: every number here is computed in code from how HE answered Abel's proposals, so it can
// be shown, checked and reversed. Neutral outcomes (expired, failed, replaced) are never counted for or against.

export type Outcome = "approved" | "dropped" | "corrected" | "expired" | "failed" | "replaced";

export interface OutcomeRow {
  tool_name: string;
  signature: string;
  outcome: Outcome;
  summary: string;
  created_at: string;
}

/** What "a suggestion like this" means: the tool, plus the category/kind when that is what he judges by. */
export function signatureOf(tool: string, args: Record<string, unknown>): string {
  if (tool === "create_expense" || tool === "update_expense") {
    const category = typeof args.category === "string" ? args.category.toLowerCase() : "";
    return category ? `${tool}/${category}` : tool;
  }
  if (tool === "save_memory") {
    const kind = typeof args.kind === "string" ? args.kind : "";
    return kind ? `${tool}/${kind}` : tool;
  }
  if (tool === "create_fuel_purchase" || tool === "stage_dump_items") return tool;
  return tool;
}

/** A plain-words name for a signature ("expense suggestions (fuel)"). */
export function labelOf(signature: string): string {
  const [tool, detail] = signature.split("/");
  const base = (tool ?? signature)
    .replace(/^create_/, "new ")
    .replace(/^update_/, "changes to ")
    .replace(/^set_/, "changes to ")
    .replace(/_/g, " ");
  return `${base}${detail ? ` (${detail})` : ""} suggestions`;
}

export interface SignatureStats {
  signature: string;
  answered: number;
  approved: number;
  /** dropped + corrected: he did not accept it as suggested. */
  declined: number;
  /** Declined share of answered, recency-weighted (answers newer than 30 days count double). */
  declineRate: number;
  lastAt: string;
}

const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 90;
export const MIN_ANSWERS = 3;
/** A signature he declines at least this often (with enough answers) is a candidate lesson / gets a risk flag. */
export const DECLINE_THRESHOLD = 0.75;
export const RISK_THRESHOLD = 0.6;

export function summarizeOutcomes(rows: OutcomeRow[], now: Date): SignatureStats[] {
  const bySig = new Map<string, { approved: number; declined: number; wApproved: number; wDeclined: number; lastAt: string }>();
  for (const row of rows) {
    if (row.outcome !== "approved" && row.outcome !== "dropped" && row.outcome !== "corrected") continue;
    const age = (now.getTime() - Date.parse(row.created_at)) / DAY_MS;
    if (!Number.isFinite(age) || age > WINDOW_DAYS) continue;
    const weight = age <= 30 ? 2 : 1;
    const s = bySig.get(row.signature) ?? { approved: 0, declined: 0, wApproved: 0, wDeclined: 0, lastAt: row.created_at };
    if (row.outcome === "approved") {
      s.approved += 1;
      s.wApproved += weight;
    } else {
      s.declined += 1;
      s.wDeclined += weight;
    }
    if (row.created_at > s.lastAt) s.lastAt = row.created_at;
    bySig.set(row.signature, s);
  }
  return [...bySig.entries()]
    .map(([signature, s]) => ({
      signature,
      answered: s.approved + s.declined,
      approved: s.approved,
      declined: s.declined,
      declineRate: s.wApproved + s.wDeclined === 0 ? 0 : s.wDeclined / (s.wApproved + s.wDeclined),
      lastAt: s.lastAt,
    }))
    .sort((a, b) => b.answered - a.answered || a.signature.localeCompare(b.signature));
}

/** A visible line for a NEW proposal whose signature he mostly declines, or null. */
export function riskNote(signature: string, stats: SignatureStats[]): string | null {
  const s = stats.find((x) => x.signature === signature);
  if (!s || s.answered < MIN_ANSWERS || s.declineRate < RISK_THRESHOLD) return null;
  return `🤔 You've turned down ${s.declined} of the last ${s.answered} ${labelOf(signature)} - still want this one?`;
}

export interface Lesson {
  signature: string;
  /** The exact memory text to propose with save_memory - carries its pattern so it is never proposed twice. */
  text: string;
}

const lessonMarker = (signature: string) => `(pattern: ${signature})`;

/** Lessons that have earned a proposal and are not already remembered. */
export function readyLessons(stats: SignatureStats[], rememberedTexts: string[]): Lesson[] {
  const lessons: Lesson[] = [];
  for (const s of stats) {
    if (s.answered < MIN_ANSWERS || s.declineRate < DECLINE_THRESHOLD) continue;
    if (rememberedTexts.some((t) => t.includes(lessonMarker(s.signature)))) continue;
    lessons.push({
      signature: s.signature,
      text: `Lesson learned from his answers: he usually turns down ${labelOf(s.signature)} (${s.declined} of ${s.answered}) - only suggest them when he asks for one. ${lessonMarker(s.signature)}`,
    });
  }
  return lessons;
}

/** The context block that lets the model adapt - computed facts about his past answers, never model-written. */
export function learningBlock(stats: SignatureStats[], lessons: Lesson[]): string | null {
  const meaningful = stats.filter((s) => s.answered >= MIN_ANSWERS);
  if (meaningful.length === 0 && lessons.length === 0) return null;
  const lines = meaningful.slice(0, 8).map((s) => `- ${labelOf(s.signature)}: approved ${s.approved}, turned down ${s.declined} (last ${s.answered} answers)`);
  const out = ["WHAT HE HAS TOLD YOU BY ANSWERING (computed from his real approvals and drops, last 90 days):", ...lines];
  if (lessons.length > 0) {
    out.push(
      "LESSON READY - propose it with save_memory (kind \"fact\", confirmation \"propose\") using EXACTLY this text, once, when it fits the conversation:",
      ...lessons.map((l) => `  "${l.text}"`),
    );
  }
  out.push("Suggest less of what he keeps turning down; never stop asking for approval on writes.");
  return out.join("\n");
}

/** The learning_report text: how his answers have gone, per signature. */
export function learningReport(stats: SignatureStats[], lessons: Lesson[]): string {
  if (stats.length === 0) return "No answers logged yet - nothing to learn from. Each time he approves, drops or corrects one of my suggestions it is recorded.";
  const lines = stats.slice(0, 15).map((s) => `${labelOf(s.signature)}: approved ${s.approved}, turned down ${s.declined} (${s.answered} answers, last ${s.lastAt.slice(0, 10)})`);
  const tail = lessons.length ? `\nLessons ready to propose: ${lessons.map((l) => labelOf(l.signature)).join(", ")}.` : "\nNo lesson has crossed the bar yet (it takes at least 3 answers and a clear pattern).";
  return `How he has answered my suggestions (last ${WINDOW_DAYS} days):\n${lines.join("\n")}${tail}`;
}
