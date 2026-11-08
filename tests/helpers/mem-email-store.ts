// An in-memory EmailStore for tests (ingest, send, tools). Mirrors the real store's contracts, including the atomic send claim.
import type { DraftRow, EmailStore, PollState, SentRow, StoredEmail } from "@/services/email/store";

export function memStore(): EmailStore & { messages: Map<string, StoredEmail & { uid: number }>; candidates: Map<string, { id: string; status: string; key: string }>; state: PollState; states: Record<string, PollState>; drafts: DraftRow[]; sent: SentRow[] } {
  const messages = new Map<string, StoredEmail & { uid: number }>();
  const candidates = new Map<string, { id: string; status: string; key: string }>();
  const mk = (): PollState => ({ uidvalidity: null, lastUid: 0, lastAttemptAt: null, lastOkAt: null, lastErrorKind: null, lastErrorAt: null, consecutiveFailures: 0, lastNotifiedState: null, lastDigestDate: null });
  const states: Record<string, PollState> = { dispatch: mk(), owner: mk() };
  const state = states.dispatch!;
  const drafts: DraftRow[] = [];
  const sent: SentRow[] = [];
  let draftSeq = 0;
  let n = 0;
  return {
    messages, candidates, state, states, drafts, sent,
    async getPollState(mb) { return { ...states[mb]! }; },
    async savePollState(mb, p) { Object.assign(states[mb]!, p); },
    async insertMessage(mailbox, m, uid) {
      const dup = [...messages.values()].find((x) => x.messageId === m.messageId);
      if (dup) return { id: dup.id, inserted: false };
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      messages.set(id, { id, mailbox, uid, messageId: m.messageId, fromAddress: m.fromAddress, fromName: m.fromName, replyTo: m.replyTo, toAddresses: m.toAddresses, subject: m.subject, receivedAt: m.receivedAt, bodyText: m.bodyText, attachments: m.attachments, classification: "unclassified", summary: null, surfacedAt: null, digestSentAt: null, linkedProposalId: null });
      return { id, inserted: true };
    },
    async setTriage(id, c, s) { const m = messages.get(id)!; m.classification = c; m.summary = s; },
    async markSurfaced(id, p) { const m = messages.get(id)!; m.surfacedAt = "now"; m.linkedProposalId = p ?? null; },
    async listUnsurfaced(_l, mb) { return [...messages.values()].filter((m) => !m.surfacedAt && m.classification !== "junk" && (!mb || m.mailbox === mb)); },
    async listJunkForDigest() { return [...messages.values()].filter((m) => m.classification === "junk" && !m.digestSentAt); },
    async markDigestSent(ids) { for (const i of ids) messages.get(i)!.digestSentAt = "now"; },
    async list() { return [...messages.values()]; },
    async get(id) { return messages.get(id) ?? null; },
    async upsertCandidate(_e, _c, key) {
      const ex = [...candidates.values()].find((c) => c.key === key);
      if (ex) return { id: ex.id, created: false };
      const id = `11111111-1111-4111-8111-${String(++n).padStart(12, "0")}`;
      candidates.set(id, { id, status: "new", key });
      return { id, created: true };
    },
    async setCandidateStatus(id, s) { candidates.get(id)!.status = s; },
    async listCandidates() { return []; },
    async createDraft(emailMessageId, to, subject, body) {
      const d: DraftRow = { id: `00000000-0000-4000-8000-d${String(++draftSeq).padStart(11, "0")}`, emailMessageId, toAddress: to, subject, body, status: "draft", createdAt: "now", sendError: null, sentAt: null };
      drafts.push(d);
      return d;
    },
    async listDrafts(emailMessageId) { return drafts.filter((d) => (d.status === "draft" || d.status === "failed") && (!emailMessageId || d.emailMessageId === emailMessageId)); },
    async getDraft(id) { return drafts.find((d) => d.id === id) ?? null; },
    async updateDraftBody(id, body) {
      const d = drafts.find((x) => x.id === id);
      if (!d || (d.status !== "draft" && d.status !== "failed")) return null;
      d.body = body; d.status = "draft"; d.sendError = null;
      return d;
    },
    async claimDraftForSend(id, expectedBody) {
      const d = drafts.find((x) => x.id === id);
      if (!d || d.body !== expectedBody || (d.status !== "draft" && d.status !== "failed")) return false;
      d.status = "sending";
      return true;
    },
    async markDraftSent(id, at) { const d = drafts.find((x) => x.id === id)!; d.status = "sent"; d.sentAt = at; d.sendError = null; },
    async markDraftFailed(id, reason) { const d = drafts.find((x) => x.id === id)!; d.status = "failed"; d.sendError = reason; },
    async insertSent(row) { const r: SentRow = { id: `s${sent.length + 1}`, ...row }; sent.push(r); return r; },
    async listSent(o) { return sent.filter((x) => !o?.emailMessageId || x.emailMessageId === o.emailMessageId); },
    async listSendFailures() { return drafts.filter((d) => d.status === "failed").map((d) => ({ ...d, mailbox: messages.get(d.emailMessageId)?.mailbox ?? "dispatch" })); },
  };
}

