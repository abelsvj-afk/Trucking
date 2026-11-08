// One poll of the company inbox, end to end (docs/design/company-inbox.md sections 4-8). Read-only on the server; on our side:
// store, triage, tell the owner, stage a draft-load PROPOSAL for load offers. Nothing here books, accepts, replies or sends.

import { randomUUID } from "node:crypto";
import type { AiProvider } from "@/services/ai/provider";
import { formatBatchProposal } from "@/services/bot/dump-intake";
import { buildBotTools } from "@/services/bot/tools";
import type { BotBrainStore } from "@/services/bot/store";
import { addDays } from "@/lib/temporal";
import { MAILBOX_LABEL, type EmailConfig, type Mailbox } from "./config";
import type { Classified } from "./errors";
import { readNewMail, withImapSession, type ImapSession } from "./imap-reader";
import { parseRaw, type ParsedEmail } from "./parse";
import type { EmailStore, PollState, StoredEmail } from "./store";
import { etDate, etHour } from "./time";
import { dedupeKey, triageEmail, type Candidate, type MailClass } from "./triage";

export { etDate, etHour, etTime } from "./time";
export const MAX_TRIAGED_PER_POLL = 15;
export const MAX_SURFACED_PER_POLL = 8;
export const DIGEST_HOUR_ET = 8;

export interface IngestDeps {
  config: EmailConfig;
  emailStore: EmailStore;
  /** The bot store - needed to stage proposals. null = proposals unavailable (mail is still stored and surfaced). */
  brain: BotBrainStore | null;
  /** null = AI is off: mail is stored and surfaced as unclassified. */
  provider: (() => AiProvider) | null;
  notify: (text: string) => Promise<boolean>;
  now: () => Date;
  open?: (c: EmailConfig) => Promise<ImapSession>;
}

export interface PollOutcome {
  ok: boolean;
  stored: number;
  surfaced: number;
  failure?: Classified;
}

const CLASS_LABEL: Record<MailClass, string> = {
  load_offer: "Load offer", payment: "Payment", facility: "Shipper/receiver", other: "Email", junk: "Junk", unclassified: "New email",
};
const sender = (m: { fromName: string | null; fromAddress: string | null }) => m.fromName ? `${m.fromName} <${m.fromAddress ?? "?"}>` : (m.fromAddress ?? "unknown sender");

/** The Telegram text for one message. The summary is model output about UNTRUSTED content - shown as information only. */
export function composeMessageAlert(m: { mailbox?: Mailbox; classification: MailClass; fromName: string | null; fromAddress: string | null; subject: string | null; summary: string | null }): string {
  const lines = [`📬 ${CLASS_LABEL[m.classification]} - ${MAILBOX_LABEL[m.mailbox ?? "dispatch"]} inbox`, `From: ${sender(m)}`, `Subject: ${m.subject ?? "(no subject)"}`];
  if (m.summary) lines.push("", m.summary);
  if (m.classification === "unclassified") lines.push("", "(Not sorted yet - I couldn't classify this one.)");
  // owner@ is the mailbox Abel can send from (owner decision 2026-11-07): offer to draft a reply together. Nothing is sent without his
  // yes to the exact text. dispatch@ sending is dormant, so no offer there.
  if (m.mailbox === "owner" && m.classification !== "junk") lines.push("", "I can draft a reply here - just say so, and nothing goes out until you approve the exact text.");
  return lines.join("\n");
}

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The workup shown with a load offer: only what the email stated, absence named, the computed rate labelled computed. */
export function composeCandidateWorkup(c: Candidate): string {
  const place = (city: string | null, st: string | null) => [city, st].filter(Boolean).join(", ") || "not stated";
  const lines = [
    `Broker: ${c.broker.company ?? "not stated"}${c.broker.mc ? ` (MC ${c.broker.mc})` : ""}`,
    `Lane: ${place(c.lane.origin_city, c.lane.origin_state)} → ${place(c.lane.destination_city, c.lane.destination_state)}`,
    `Pickup: ${c.lane.pickup_window ?? c.lane.pickup_date ?? "not stated"} · Delivery: ${c.lane.delivery_window ?? c.lane.delivery_date ?? "not stated"}`,
    `Miles: ${c.lane.miles ?? "not stated"} · Posted rate: ${c.money.rate_cents !== null ? dollars(c.money.rate_cents) : "not stated"}${c.money.rate_per_mile_cents_computed !== null ? ` (${dollars(c.money.rate_per_mile_cents_computed)}/mi - computed by me, not posted)` : ""}`,
    `Freight: ${[c.load.commodity, c.load.equipment, c.load.weight_lbs ? `${c.load.weight_lbs.toLocaleString("en-US")} lb` : null].filter(Boolean).join(" · ") || "not stated"}`,
  ];
  if (c.requirements) lines.push(`Requirements as posted: ${c.requirements}`);
  if (c.rejected.length) lines.push(`⚠ Ignored as not believable: ${c.rejected.join(", ")}`);
  return lines.join("\n");
}

/** create_load arguments from a candidate. Always a DRAFT; only stated fields; the rate is the posted total. */
export function candidateToLoadArgs(c: Candidate, emailSubject: string | null): Record<string, unknown> {
  const place = (city: string | null, st: string | null) => [city, st].filter(Boolean).join(", ");
  const args: Record<string, unknown> = {
    origin: place(c.lane.origin_city, c.lane.origin_state) || "Origin not stated",
    destination: place(c.lane.destination_city, c.lane.destination_state) || "Destination not stated",
    status: "draft",
    notes: [`Offer from email${c.broker.company ? ` (${c.broker.company})` : ""}${emailSubject ? ` - "${emailSubject.slice(0, 120)}"` : ""}. Not a booked load: no rate confirmation signed.`, c.requirements ? `Requirements as posted: ${c.requirements}` : ""].filter(Boolean).join(" "),
  };
  if (c.lane.origin_state) args.origin_state = c.lane.origin_state;
  if (c.lane.destination_state) args.destination_state = c.lane.destination_state;
  if (c.lane.pickup_date) args.pickup_date = c.lane.pickup_date;
  if (c.lane.delivery_date) args.delivery_date = c.lane.delivery_date;
  if (c.lane.miles !== null) args.miles = Math.round(c.lane.miles);
  if (c.money.rate_cents !== null) args.rate_dollars = c.money.rate_cents / 100;
  if (c.load.weight_lbs !== null) args.weight_lbs = Math.round(c.load.weight_lbs);
  return args;
}

/** Stage the draft-load proposal through the normal flow. Returns the pending id's batch id, or null when it could not be staged. */
async function stageOffer(deps: IngestDeps, candidateId: string, c: Candidate, msg: ParsedEmail | StoredEmail): Promise<string | null> {
  if (!deps.brain) return null;
  const subject = "subject" in msg ? msg.subject : null;
  const tool = buildBotTools(deps.brain).find((t) => t.name === "create_load" && t.access === "write");
  if (!tool) return null;
  const checked = tool.validateArgs ? tool.validateArgs(candidateToLoadArgs(c, subject ?? null)) : { ok: true as const, args: candidateToLoadArgs(c, subject ?? null) };
  if (!checked.ok) return null;
  const batchId = randomUUID();
  await deps.brain.savePendingAction({
    toolName: "create_load",
    args: checked.args,
    summary: tool.summarize ? tool.summarize(checked.args) : "Create draft load",
    batchId,
    itemNumber: 1,
    sourceQuote: `email-candidate:${candidateId}`,
    confidence: "medium",
  });
  return batchId;
}

async function announceHealth(deps: IngestDeps, state: PollState, next: "ok" | Classified["kind"], failure?: Classified): Promise<void> {
  const mailbox = deps.config.mailbox;
  const label = MAILBOX_LABEL[mailbox];
  const previous = state.lastNotifiedState;
  if (previous === next) return; // a repeat is never re-announced
  if (next === "ok") {
    if (previous === null) {
      // First ever successful poll: nothing was broken, nothing to announce - just remember it.
      await deps.emailStore.savePollState(mailbox, { lastNotifiedState: "ok" });
      return;
    }
    if (await deps.notify(`✅ The ${label} inbox is connected again. I'm reading its mail normally.`)) await deps.emailStore.savePollState(mailbox, { lastNotifiedState: "ok" });
    return;
  }
  const text = `⚠️ I can't read the ${label} inbox. ${failure?.message ?? "The mailbox poll failed."}${next === "auth" ? ` The mailbox login needs attention (the Fly secret IONOS_EMAIL_${mailbox.toUpperCase()}_PASSWORD).` : ""}`;
  if (await deps.notify(text)) await deps.emailStore.savePollState(mailbox, { lastNotifiedState: next });
}

export async function pollOnce(deps: IngestDeps): Promise<PollOutcome> {
  const { emailStore, now } = deps;
  const mailbox = deps.config.mailbox;
  const state = await emailStore.getPollState(mailbox);
  const startedAt = now();
  await emailStore.savePollState(mailbox, { lastAttemptAt: startedAt.toISOString() });

  const read = await withImapSession(
    deps.config,
    (s) => readNewMail(s, { uidvalidity: state.uidvalidity, lastUid: state.lastUid }, startedAt),
    deps.open,
  );
  if (!read.ok) {
    await emailStore.savePollState(mailbox, { lastErrorKind: read.failure.kind, lastErrorAt: startedAt.toISOString(), consecutiveFailures: state.consecutiveFailures + 1 });
    await announceHealth(deps, state, read.failure.kind, read.failure);
    return { ok: false, stored: 0, surfaced: 0, failure: read.failure };
  }

  // Store everything first; the cursor moves only past messages that are stored.
  const { messages, uidvalidity, nextLastUid } = read.value;
  const fresh: { id: string; email: ParsedEmail }[] = [];
  for (const raw of messages) {
    let email: ParsedEmail;
    try {
      email = await parseRaw(raw.source, raw.internalDate ?? startedAt);
    } catch {
      continue; // an unparseable message is skipped, never allowed to wedge the cursor
    }
    const { id, inserted } = await emailStore.insertMessage(mailbox, email, raw.uid, uidvalidity);
    if (inserted) fresh.push({ id, email });
  }
  await emailStore.savePollState(mailbox, {
    uidvalidity,
    lastUid: nextLastUid,
    lastOkAt: startedAt.toISOString(),
    lastErrorKind: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
  });
  await announceHealth(deps, state, "ok");

  const firstRun = state.uidvalidity === null || state.uidvalidity !== uidvalidity;
  const surfaced = await triageAndSurface(deps, fresh, firstRun);
  await sendDigestIfDue(deps);
  return { ok: true, stored: fresh.length, surfaced };
}

async function triageAndSurface(deps: IngestDeps, fresh: { id: string; email: ParsedEmail }[], firstRun: boolean): Promise<number> {
  const { emailStore } = deps;
  const mailbox = deps.config.mailbox;
  const today = etDate(deps.now());
  const provider = deps.provider ? safeProvider(deps.provider) : null;
  const triaged = new Map<string, { classification: MailClass; summary: string; candidate: Candidate | null }>();
  let budget = MAX_TRIAGED_PER_POLL;
  for (const { id, email } of fresh) {
    if (!provider || budget <= 0) continue;
    budget -= 1;
    const t = await triageEmail(provider, email, today);
    triaged.set(id, t);
    await emailStore.setTriage(id, t.classification, t.summary);
  }

  // Everything stored and not yet surfaced (also catches a previous poll that stopped midway), junk excluded.
  const waiting = await emailStore.listUnsurfaced(50, mailbox);
  if (firstRun && waiting.length > MAX_SURFACED_PER_POLL) {
    // Backfill after a first connection or a rebuilt mailbox: one summary instead of a flood.
    const lines = waiting.slice(0, 12).map((m) => `• ${sender(m)} - ${m.subject ?? "(no subject)"}`);
    const ok = await deps.notify(`📬 ${MAILBOX_LABEL[mailbox]} inbox connected. ${waiting.length} messages from the last 7 days are waiting (not opened on the server):\n${lines.join("\n")}${waiting.length > 12 ? `\n…and ${waiting.length - 12} more` : ""}\nAsk me to show the inbox for details.`);
    if (ok) for (const m of waiting) await emailStore.markSurfaced(m.id);
    return ok ? waiting.length : 0;
  }

  let surfaced = 0;
  for (const m of waiting.slice(0, MAX_SURFACED_PER_POLL)) {
    let proposalNote = "";
    let batchId: string | null = null;
    const t = triaged.get(m.id);
    if (m.classification === "load_offer" && t?.candidate) {
      try {
        const key = dedupeKey(t.candidate);
        const expires = t.candidate.lane.delivery_date ?? t.candidate.lane.pickup_date ?? addDays(today, 14);
        const { id: candidateId, created } = await emailStore.upsertCandidate(m.id, t.candidate, key, expires);
        proposalNote = `\n\n${composeCandidateWorkup(t.candidate)}`;
        if (created) {
          batchId = await stageOffer(deps, candidateId, t.candidate, m);
          if (batchId) {
            await emailStore.setCandidateStatus(candidateId, "proposed");
            proposalNote += formatBatchProposal([{ summary: "Save this offer as a DRAFT load (not booked - no rate confirmation signed)", sourceQuote: m.subject ?? undefined, confidence: "medium" }]);
          }
        } else {
          proposalNote += "\n\n(I've already seen this same load - not proposing it twice.)";
        }
      } catch (err) {
        console.error("[email] candidate not staged", err instanceof Error ? err.message : "error");
      }
    }
    const sent = await deps.notify(composeMessageAlert(m) + proposalNote);
    if (sent) {
      await emailStore.markSurfaced(m.id, batchId);
      surfaced += 1;
    } else if (batchId && deps.brain) {
      // The alert failed to send: take the proposal back so the retry next poll doesn't leave a second one behind.
      const open = await deps.brain.loadOpenPendingRows();
      await deps.brain.clearPendingActions(open.filter((r) => r.batch_id === batchId).map((r) => r.id));
    }
  }
  return surfaced;
}

function safeProvider(make: () => AiProvider): AiProvider | null {
  try {
    return make();
  } catch {
    return null;
  }
}

/** Junk never interrupts: one digest (both mailboxes together) at/after 8 AM Eastern, only if there is any, at most once per Eastern day. */
export async function sendDigestIfDue(deps: IngestDeps): Promise<boolean> {
  const now = deps.now();
  if (etHour(now) < DIGEST_HOUR_ET) return false;
  const today = etDate(now);
  for (const box of ["dispatch", "owner"] as const) {
    if ((await deps.emailStore.getPollState(box)).lastDigestDate === today) return false;
  }
  const junk = await deps.emailStore.listJunkForDigest(100);
  if (junk.length === 0) return false;
  const lines = junk.slice(0, 15).map((m) => `• [${MAILBOX_LABEL[m.mailbox]}] ${sender(m)} - ${m.subject ?? "(no subject)"}`);
  const ok = await deps.notify(`🗑 Junk in the company inboxes (${junk.length}) - nothing needed from you:\n${lines.join("\n")}${junk.length > 15 ? `\n…and ${junk.length - 15} more` : ""}`);
  if (!ok) return false;
  await deps.emailStore.markDigestSent(junk.map((m) => m.id));
  await deps.emailStore.savePollState(deps.config.mailbox, { lastDigestDate: today });
  return true;
}
