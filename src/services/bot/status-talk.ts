// "I'm off duty for 19 minutes so far" is information to act on, not small talk (owner transcript 2026-11-12:
// Abel answered "Thanks for the update!" and logged nothing). When his words state his duty status, code lines up
// ONE log_duty_status proposal with the start time worked out from what he said - for his yes, never executed on
// its own (it is his paper-log helper, not the ELD). docs/design/abel-do-what-i-ask.md section 4.

import type { BotBrainStore } from "./store";

export type DutyStatus = "off_duty" | "sleeper" | "driving" | "on_duty";

export interface StatusTalk {
  status: DutyStatus;
  /** Minutes ago the status began (0 = now). */
  minutesAgo: number;
}

const STATUS_WORDS: [RegExp, DutyStatus][] = [
  [/\boff[- ]?duty\b|\boff the clock\b|\bclocked out\b/, "off_duty"],
  [/\b(sleeper( berth)?|in the bunk|going to sleep|in bed)\b/, "sleeper"],
  [/\bon[- ]?duty\b|\bclocked in\b/, "on_duty"],
  [/\b(driving|rolling|on the road|back on the road|moving)\b/, "driving"],
];

function minutesFrom(t: string): number | null {
  const m = t.match(/\b(\d{1,3}(?:\.\d)?|an?|half an?)\s*(minutes?|mins?|hours?|hrs?|h)\b/);
  if (!m) return null;
  const n = m[1] === "a" || m[1] === "an" ? 1 : /^half/.test(m[1]!) ? 0.5 : Number.parseFloat(m[1]!);
  return Math.round(/^h/.test(m[2]!) ? n * 60 : n);
}

/**
 * His words as a status statement, or null. Only first-person present statements count ("I'm off duty",
 * "been driving 2 hours", "just went off duty", "I'm in the sleeper") - a question, a plan ("I'll be off duty at
 * 5"), a negation, or a mention inside a longer message is NOT a statement and is left to the model.
 */
export function parseStatusTalk(text: string): StatusTalk | null {
  const t = text.toLowerCase().trim().replace(/[.!]+$/, "");
  if (t.length > 80 || t.includes("?")) return null;
  if (/\b(will|i'll|gonna|going to be|about to|at \d|until|not|n't|no longer|should|was i|am i|tomorrow|later)\b/.test(t)) return null;
  if (!/^(i'?m|i am|im|been|just|now|currently|i've been|i have been|i went|went|started|i started|back)\b/.test(t)) return null;
  const hit = STATUS_WORDS.find(([re]) => re.test(t));
  if (!hit) return null;
  const minutes = minutesFrom(t);
  return { status: hit[1], minutesAgo: minutes !== null && minutes <= 14 * 60 ? minutes : 0 };
}

const LABEL: Record<DutyStatus, string> = { off_duty: "Off duty", sleeper: "Sleeper", driving: "Driving", on_duty: "On duty" };

/** His latest logged status, or null when none / unreadable. */
async function latestStatus(store: BotBrainStore): Promise<{ status: string; started_at: string } | null> {
  const { data, error } = await store.client
    .from("duty_logs")
    .select("duty_status, started_at")
    .eq("company_id", store.companyId)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const row = data[0] as { duty_status: string; started_at: string };
  return { status: row.duty_status, started_at: row.started_at };
}

export interface StatusTalkOutcome {
  kind: "already" | "propose";
  status: DutyStatus;
  startedAt: string;
  label: string;
}

/** What to do with a status statement: nothing (the log already says so) or one proposal. */
export async function planStatusTalk(store: BotBrainStore, talk: StatusTalk, now: Date): Promise<StatusTalkOutcome> {
  const startedAt = new Date(now.getTime() - talk.minutesAgo * 60_000).toISOString();
  const latest = await latestStatus(store).catch(() => null);
  if (latest && latest.status === talk.status) {
    return { kind: "already", status: talk.status, startedAt: latest.started_at, label: LABEL[talk.status] };
  }
  return { kind: "propose", status: talk.status, startedAt, label: LABEL[talk.status] };
}
