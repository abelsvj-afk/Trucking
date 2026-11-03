// Abel Intelligence Upgrade, Phase C (design §4 + the owner's
// 2026-11-02 per-person learning scope). The CODE half of thread
// intelligence: which stored thread a new forward belongs to,
// how participants merge, what a thread's language shape is, and
// what the accumulated evidence about one person actually supports
// saying. The model reconstructs conversations (thread-extraction
// .ts); everything here is deterministic - matching, counting, and
// confidence are never model vibes.
//
// The per-person model discipline (owner's binding scope): a model
// is built ONLY from accumulated evidence (his forwards + dispatch
// exchanges), every claim carries its evidence count, confidence
// is labeled in plain buckets computed here, and the model is
// staged through propose->approve as a person_profile with
// provenance "model_inferred_unconfirmed" until HE confirms it.
// It is correctable like any profile (a new save supersedes), and
// it never overstates: thin evidence says thin.

import { formatPersonProfile, type PersonProfile } from "./people";
import type { ThreadParticipant } from "@/services/ai/thread-extraction";

export type { ThreadParticipant };

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[.,'"]/g, "")
    .replace(/\s+/g, " ");
}

function participantNames(participants: ThreadParticipant[]): Set<string> {
  return new Set(participants.map((p) => normalizeName(p.name)).filter(Boolean));
}

/** Shared non-owner participants between two participant lists - the append signal. The owner is in every thread, so he never counts as a match. */
export function sharedCounterparties(a: ThreadParticipant[], b: ThreadParticipant[]): string[] {
  const namesA = participantNames(a);
  const out: string[] = [];
  for (const p of b) {
    const key = normalizeName(p.name);
    if (!key || p.role === "owner") continue;
    if (namesA.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

export interface OpenThreadCandidate {
  id: string;
  participants: ThreadParticipant[];
  updatedAt: string;
}

/**
 * Which open thread a new segment appends to: the open thread
 * sharing the most counterparties; ties break to the most recently
 * updated. No shared counterparty -> no append (a new thread).
 * Deliberately conservative: a wrong merge corrupts two threads'
 * history; a missed merge just starts a sibling thread he can see.
 */
export function matchThreadForAppend(
  openThreads: OpenThreadCandidate[],
  incoming: ThreadParticipant[],
): string | null {
  let best: { id: string; shared: number; updatedAt: string } | null = null;
  for (const thread of openThreads) {
    const shared = sharedCounterparties(thread.participants, incoming).length;
    if (shared === 0) continue;
    if (
      !best ||
      shared > best.shared ||
      (shared === best.shared && thread.updatedAt > best.updatedAt)
    ) {
      best = { id: thread.id, shared, updatedAt: thread.updatedAt };
    }
  }
  return best?.id ?? null;
}

/** Union of two participant lists by normalized name. An established role beats "other"; otherwise the existing record wins (his corrections live on the stored record). */
export function mergeParticipants(
  existing: ThreadParticipant[],
  incoming: ThreadParticipant[],
): ThreadParticipant[] {
  const byKey = new Map<string, ThreadParticipant>();
  for (const p of existing) byKey.set(normalizeName(p.name), { ...p });
  for (const p of incoming) {
    const key = normalizeName(p.name);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...p });
    } else if (current.role === "other" && p.role !== "other") {
      byKey.set(key, { name: current.name, role: p.role });
    }
  }
  return [...byKey.values()];
}

/** The thread's language shape from its messages' own tags (code, not the model's say-so). */
export function threadLanguageFromMessages(
  messages: { language: string }[],
): "en" | "es" | "mixed" | null {
  const tags = new Set(messages.map((m) => m.language).filter((l) => l === "en" || l === "es"));
  if (tags.size === 2) return "mixed";
  if (tags.has("en")) return "en";
  if (tags.has("es")) return "es";
  return null;
}

/** The compact open-loops context block: only unanswered asks ride context (max 3), so "anything hanging?" is grounded before he asks. Null when nothing is hanging. */
export function formatOpenLoopsBlock(
  threads: {
    title: string | null;
    theAsk: string | null;
    askOf: string | null;
    deadlineText: string | null;
    participants: ThreadParticipant[];
  }[],
): string | null {
  const loops = threads.filter((t) => t.theAsk).slice(0, 3);
  if (loops.length === 0) return null;
  const lines = loops.map((t) => {
    const who = t.participants.filter((p) => p.role !== "owner").map((p) => p.name).join(", ");
    return `- ${t.title ?? `Thread with ${who || "unknown"}`}: "${t.theAsk}"${t.askOf ? ` — waiting on ${t.askOf}` : ""}${t.deadlineText ? ` — deadline ${t.deadlineText}` : ""}`;
  });
  return `OPEN LOOPS (unanswered asks in his recorded threads - if he asks what's hanging, answer from these records, and use list_open_threads for the full list):\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Per-person model (owner scope, 2026-11-02)
// ---------------------------------------------------------------------------

export interface PersonEvidence {
  /** The confirmed profile, when he has one (his word outranks the model, always). */
  confirmedProfile: PersonProfile | null;
  /** Thread appearances: role seen, messages they sent, asks they made, last activity. */
  threads: {
    title: string | null;
    role: string;
    messagesFromThem: number;
    lastActiveAt: string;
  }[];
  /** Their message bodies (for topic counting in code). */
  messageBodies: string[];
  /** Dispatch exchanges whose incoming text names them. */
  exchangeMentions: number;
}

export type PersonModelConfidence = "well-evidenced" | "some evidence" | "thin" | "no evidence";

export interface PersonModel {
  name: string;
  /** The role the evidence most often shows (null = never established). */
  roleFromEvidence: string | null;
  topics: string[];
  threadCount: number;
  messagesFromThem: number;
  exchangeMentions: number;
  evidenceCount: number;
  confidence: PersonModelConfidence;
  /** Plain lines Abel may quote - every claim carries its count. */
  lines: string[];
  /** The person_profile line a proposal would save (null when there is no evidence to propose from). */
  proposedProfileLine: string | null;
}

const TOPIC_STOPWORDS = new Set([
  // English function words + trucking-generic fillers that say nothing about a person
  "the", "and", "for", "you", "that", "this", "with", "have", "will", "your", "from", "they", "them", "then", "than", "what", "when", "just", "like", "load", "loads", "truck", "driver", "okay", "yeah", "yes", "please", "thanks", "thank",
  // Spanish function words
  "que", "los", "las", "una", "uno", "con", "por", "para", "esta", "este", "esto", "pero", "como", "cuando", "donde", "tiene", "tienes", "hacer", "favor", "gracias", "bueno", "bien", "hora", "horas",
]);

/** Top content words across a person's own messages - what they actually talk to him about, counted in code. */
export function topTopics(bodies: string[], limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const body of bodies) {
    for (const raw of body.toLowerCase().split(/[^a-záéíóúñü0-9]+/)) {
      const word = raw.trim();
      if (word.length < 4 || TOPIC_STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

export function buildPersonModel(name: string, evidence: PersonEvidence): PersonModel {
  const threadCount = evidence.threads.length;
  const messagesFromThem = evidence.threads.reduce((t, th) => t + th.messagesFromThem, 0);
  const evidenceCount = threadCount + messagesFromThem + evidence.exchangeMentions;
  const confidence: PersonModelConfidence =
    evidenceCount >= 15 ? "well-evidenced" : evidenceCount >= 6 ? "some evidence" : evidenceCount >= 1 ? "thin" : "no evidence";

  const roleCounts = new Map<string, number>();
  for (const th of evidence.threads) {
    if (th.role && th.role !== "other") roleCounts.set(th.role, (roleCounts.get(th.role) ?? 0) + 1);
  }
  const roleFromEvidence =
    [...roleCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? evidence.confirmedProfile?.role ?? null;

  const topics = topTopics(evidence.messageBodies);
  const displayName = evidence.confirmedProfile?.name ?? name;

  const lines: string[] = [];
  if (evidence.confirmedProfile) {
    lines.push(
      `Confirmed profile (his approved words - these outrank the model): ${formatPersonProfile(evidence.confirmedProfile)}`,
    );
  }
  if (evidenceCount === 0) {
    lines.push(
      `No accumulated evidence about ${displayName} yet - no forwarded threads, no messages from them, no dispatch exchanges naming them. There is nothing honest to model; say so plainly rather than inventing a profile.`,
    );
  } else {
    lines.push(
      `Evidence from his forwards: ${threadCount} thread(s), ${messagesFromThem} message(s) from them, ${evidence.exchangeMentions} dispatch exchange(s) naming them. Model confidence: ${confidence.toUpperCase()} - state it with the model, never stronger.`,
    );
    if (roleFromEvidence) lines.push(`Role the evidence shows: ${roleFromEvidence}.`);
    if (topics.length > 0) {
      lines.push(`What they communicate with him about (words counted from their own messages): ${topics.join(", ")}.`);
    } else {
      lines.push("Not enough of their messages yet to name topics honestly (a topic needs at least 2 mentions).");
    }
  }

  let proposedProfileLine: string | null = null;
  if (evidenceCount > 0) {
    const facts: string[] = [];
    if (topics.length > 0) facts.push(`Communicates with him about: ${topics.join(", ")}.`);
    facts.push(
      `Seen in ${threadCount} forwarded thread(s) and ${messagesFromThem} message(s) from them.`,
      `Abel's model, confidence ${confidence} - inferred from his forwards, NOT confirmed by him; correct anything wrong.`,
    );
    proposedProfileLine = formatPersonProfile({
      name: displayName,
      role: roleFromEvidence,
      facts,
    });
  }

  return {
    name: displayName,
    roleFromEvidence,
    topics,
    threadCount,
    messagesFromThem,
    exchangeMentions: evidence.exchangeMentions,
    evidenceCount,
    confidence,
    lines,
    proposedProfileLine,
  };
}
