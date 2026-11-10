// Persistence for the company inbox (migration 00078). Every query is scoped to the company. There is no method here
// that sends, deletes or alters mail on the server - this file only touches our own tables.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedEmail } from "./parse";
import type { Candidate, MailClass } from "./triage";
import type { ErrorKind } from "./errors";
import type { Mailbox } from "./config";

export interface PollState {
  uidvalidity: string | null;
  lastUid: number;
  lastAttemptAt: string | null;
  lastOkAt: string | null;
  lastErrorKind: ErrorKind | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  lastNotifiedState: string | null;
  lastDigestDate: string | null;
}

export interface StoredEmail {
  id: string;
  mailbox: Mailbox;
  messageId: string;
  fromAddress: string | null;
  fromName: string | null;
  replyTo: string | null;
  toAddresses: string | null;
  subject: string | null;
  receivedAt: string;
  bodyText: string | null;
  attachments: { name: string; type: string | null; bytes: number | null }[];
  classification: MailClass;
  summary: string | null;
  surfacedAt: string | null;
  digestSentAt: string | null;
  linkedProposalId: string | null;
}

const MESSAGE_COLUMNS =
  "id, mailbox, message_id, from_address, from_name, reply_to, to_addresses, subject, received_at, body_text, attachments, classification, summary, surfaced_at, digest_sent_at, linked_proposal_id";

function toStored(r: Record<string, unknown>): StoredEmail {
  return {
    id: String(r.id),
    mailbox: r.mailbox === "owner" ? "owner" : "dispatch",
    messageId: String(r.message_id),
    fromAddress: (r.from_address as string | null) ?? null,
    fromName: (r.from_name as string | null) ?? null,
    replyTo: (r.reply_to as string | null) ?? null,
    toAddresses: (r.to_addresses as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    receivedAt: String(r.received_at),
    bodyText: (r.body_text as string | null) ?? null,
    attachments: Array.isArray(r.attachments) ? (r.attachments as StoredEmail["attachments"]) : [],
    classification: ((r.classification as MailClass) ?? "unclassified"),
    summary: (r.summary as string | null) ?? null,
    surfacedAt: (r.surfaced_at as string | null) ?? null,
    digestSentAt: (r.digest_sent_at as string | null) ?? null,
    linkedProposalId: (r.linked_proposal_id as string | null) ?? null,
  };
}

export type DraftStatus = "draft" | "discarded" | "sending" | "sent" | "failed";

export interface DraftRow {
  id: string;
  /** The inbox message this draft replies to; NULL for a standalone draft (migration 00086, roadside sends). */
  emailMessageId: string | null;
  /** The mailbox a STANDALONE draft sends from, recorded on the draft itself (00086). NULL on reply drafts: their mailbox is derived from the original message, as before. */
  mailbox: Mailbox | null;
  toAddress: string;
  subject: string;
  body: string;
  status: DraftStatus;
  createdAt: string;
  sendError: string | null;
  sentAt: string | null;
}

export interface SentRow {
  id: string;
  mailbox: Mailbox;
  /** The inbox message this replies to; NULL for a standalone send (00086). */
  emailMessageId: string | null;
  toAddress: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo: string | null;
  approvedBodyHash: string;
  sentAt: string;
  storedInSentFolder: boolean;
}

export interface EmailStore {
  getPollState(mailbox: Mailbox): Promise<PollState>;
  savePollState(mailbox: Mailbox, patch: Partial<PollState>): Promise<void>;
  /** Stores a message once however many polls see it. `inserted` is false for a repeat. */
  insertMessage(mailbox: Mailbox, m: ParsedEmail, uid: number, uidvalidity: string): Promise<{ id: string; inserted: boolean }>;
  setTriage(id: string, classification: MailClass, summary: string): Promise<void>;
  markSurfaced(id: string, proposalId?: string | null): Promise<void>;
  /** Messages stored but not yet classified/surfaced (a poll that stopped midway), oldest first. */
  listUnsurfaced(limit: number, mailbox?: Mailbox): Promise<StoredEmail[]>;
  listJunkForDigest(limit: number): Promise<StoredEmail[]>;
  markDigestSent(ids: string[]): Promise<void>;
  list(opts: { query?: string; classification?: string; mailbox?: Mailbox; limit?: number }): Promise<StoredEmail[]>;
  get(id: string): Promise<StoredEmail | null>;
  /** Creates the candidate, or returns the existing id (same dedupe key = same load from another source). */
  upsertCandidate(emailId: string | null, c: Candidate, key: string, expiresAt: string | null): Promise<{ id: string; created: boolean }>;
  setCandidateStatus(id: string, status: "new" | "proposed" | "taken" | "passed" | "expired"): Promise<void>;
  listCandidates(limit: number): Promise<{ id: string; status: string; data: Candidate; firstSeenAt: string }[]>;
  createDraft(emailMessageId: string, toAddress: string, subject: string, body: string): Promise<DraftRow>;
  /** A draft that is NOT a reply (roadside inspection send, 00086): no original message; the sending mailbox is recorded on the draft. Throws until migration 00086 is applied - callers translate that into plain words. */
  createStandaloneDraft(toAddress: string, subject: string, body: string, mailbox: Mailbox): Promise<DraftRow>;
  /** Open drafts (draft or failed), newest first. */
  listDrafts(emailMessageId?: string): Promise<DraftRow[]>;
  getDraft(id: string): Promise<DraftRow | null>;
  /** Rewrites an unsent draft's body. Returns null when the draft is not open (already sent / being sent / discarded). */
  updateDraftBody(id: string, body: string): Promise<DraftRow | null>;
  /** The atomic claim: moves draft|failed -> sending ONLY while the body is still exactly `expectedBody`. False = lost the race or it changed. */
  claimDraftForSend(id: string, expectedBody: string, attemptedAt: string): Promise<boolean>;
  markDraftSent(id: string, sentAt: string): Promise<void>;
  markDraftFailed(id: string, reason: string, attemptedAt: string): Promise<void>;
  insertSent(row: Omit<SentRow, "id">): Promise<SentRow>;
  listSent(opts?: { emailMessageId?: string; limit?: number }): Promise<SentRow[]>;
  /** Drafts whose last send failed and have not been fixed, newest first. */
  listSendFailures(limit?: number): Promise<(DraftRow & { mailbox: Mailbox })[]>;
}

const isDuplicate = (e: { message?: string; code?: string } | null) => Boolean(e && (e.code === "23505" || /duplicate key|unique/i.test(e.message ?? "")));

export function createEmailStore(client: SupabaseClient, company: string): EmailStore {
  const throwIf = (error: { message: string } | null) => {
    if (error) throw new Error(error.message);
  };
  return {
    async getPollState(mailbox) {
      const { data, error } = await client.from("email_poll_state").select("*").eq("company_id", company).eq("mailbox", mailbox).maybeSingle();
      throwIf(error);
      const r = (data ?? {}) as Record<string, unknown>;
      return {
        uidvalidity: r.uidvalidity == null ? null : String(r.uidvalidity),
        lastUid: Number(r.last_uid ?? 0),
        lastAttemptAt: (r.last_attempt_at as string | null) ?? null,
        lastOkAt: (r.last_ok_at as string | null) ?? null,
        lastErrorKind: (r.last_error_kind as ErrorKind | null) ?? null,
        lastErrorAt: (r.last_error_at as string | null) ?? null,
        consecutiveFailures: Number(r.consecutive_failures ?? 0),
        lastNotifiedState: (r.last_notified_state as string | null) ?? null,
        lastDigestDate: (r.last_digest_date as string | null) ?? null,
      };
    },

    async savePollState(mailbox, patch) {
      const row: Record<string, unknown> = { company_id: company, mailbox, updated_at: new Date().toISOString() };
      if ("uidvalidity" in patch) row.uidvalidity = patch.uidvalidity == null ? null : Number(patch.uidvalidity);
      if ("lastUid" in patch) row.last_uid = patch.lastUid;
      if ("lastAttemptAt" in patch) row.last_attempt_at = patch.lastAttemptAt;
      if ("lastOkAt" in patch) row.last_ok_at = patch.lastOkAt;
      if ("lastErrorKind" in patch) row.last_error_kind = patch.lastErrorKind;
      if ("lastErrorAt" in patch) row.last_error_at = patch.lastErrorAt;
      if ("consecutiveFailures" in patch) row.consecutive_failures = patch.consecutiveFailures;
      if ("lastNotifiedState" in patch) row.last_notified_state = patch.lastNotifiedState;
      if ("lastDigestDate" in patch) row.last_digest_date = patch.lastDigestDate;
      const { error } = await client.from("email_poll_state").upsert(row, { onConflict: "company_id,mailbox" });
      throwIf(error);
    },

    async insertMessage(mailbox, m, uid, uidvalidity) {
      const row = {
        company_id: company,
        mailbox,
        message_id: m.messageId,
        uid,
        uidvalidity: Number(uidvalidity) || null,
        from_address: m.fromAddress,
        from_name: m.fromName,
        reply_to: m.replyTo,
        to_addresses: m.toAddresses,
        subject: m.subject,
        received_at: m.receivedAt,
        body_text: m.bodyText,
        attachments: m.attachments,
      };
      const { data, error } = await client.from("email_messages").insert(row).select("id").single();
      if (!error && data) return { id: String((data as { id: string }).id), inserted: true };
      if (!isDuplicate(error)) throw new Error(error?.message ?? "insert failed");
      const existing = await client.from("email_messages").select("id").eq("company_id", company).eq("message_id", m.messageId).maybeSingle();
      throwIf(existing.error);
      if (!existing.data) throw new Error("duplicate message vanished");
      return { id: String((existing.data as { id: string }).id), inserted: false };
    },

    async setTriage(id, classification, summary) {
      const { error } = await client.from("email_messages").update({ classification, summary: summary.slice(0, 600) }).eq("id", id).eq("company_id", company);
      throwIf(error);
    },

    async markSurfaced(id, proposalId) {
      const { error } = await client
        .from("email_messages")
        .update({ surfaced_at: new Date().toISOString(), ...(proposalId ? { linked_proposal_id: proposalId } : {}) })
        .eq("id", id)
        .eq("company_id", company);
      throwIf(error);
    },

    async listUnsurfaced(limit, mailbox) {
      let q = client
        .from("email_messages")
        .select(MESSAGE_COLUMNS)
        .eq("company_id", company)
        .is("deleted_at", null)
        .is("surfaced_at", null)
        .neq("classification", "junk")
        .order("received_at", { ascending: true })
        .limit(limit);
      if (mailbox) q = q.eq("mailbox", mailbox);
      const { data, error } = await q;
      throwIf(error);
      return ((data ?? []) as Record<string, unknown>[]).map(toStored);
    },

    async listJunkForDigest(limit) {
      const { data, error } = await client
        .from("email_messages")
        .select(MESSAGE_COLUMNS)
        .eq("company_id", company)
        .is("deleted_at", null)
        .eq("classification", "junk")
        .is("digest_sent_at", null)
        .order("received_at", { ascending: true })
        .limit(limit);
      throwIf(error);
      return ((data ?? []) as Record<string, unknown>[]).map(toStored);
    },

    async markDigestSent(ids) {
      if (ids.length === 0) return;
      const { error } = await client.from("email_messages").update({ digest_sent_at: new Date().toISOString() }).in("id", ids).eq("company_id", company);
      throwIf(error);
    },

    async list({ query, classification, mailbox, limit = 20 }) {
      let q = client.from("email_messages").select(MESSAGE_COLUMNS).eq("company_id", company).is("deleted_at", null);
      if (classification) q = q.eq("classification", classification);
      if (mailbox) q = q.eq("mailbox", mailbox);
      const term = (query ?? "").replace(/[%,()*\\]/g, " ").trim();
      if (term) q = q.or(`subject.ilike.%${term}%,from_address.ilike.%${term}%,from_name.ilike.%${term}%,summary.ilike.%${term}%`);
      const { data, error } = await q.order("received_at", { ascending: false }).limit(Math.min(Math.max(limit, 1), 50));
      throwIf(error);
      return ((data ?? []) as Record<string, unknown>[]).map(toStored);
    },

    async get(id) {
      const { data, error } = await client.from("email_messages").select(MESSAGE_COLUMNS).eq("company_id", company).eq("id", id).is("deleted_at", null).maybeSingle();
      throwIf(error);
      return data ? toStored(data as Record<string, unknown>) : null;
    },

    async upsertCandidate(emailId, c, key, expiresAt) {
      const { data, error } = await client
        .from("load_candidates")
        .insert({ company_id: company, email_message_id: emailId, source: "email", data: c, dedupe_key: key, expires_at: expiresAt })
        .select("id")
        .single();
      if (!error && data) return { id: String((data as { id: string }).id), created: true };
      if (!isDuplicate(error)) throw new Error(error?.message ?? "insert failed");
      const existing = await client.from("load_candidates").select("id").eq("company_id", company).eq("dedupe_key", key).maybeSingle();
      throwIf(existing.error);
      if (!existing.data) throw new Error("duplicate candidate vanished");
      return { id: String((existing.data as { id: string }).id), created: false };
    },

    async setCandidateStatus(id, status) {
      const { error } = await client.from("load_candidates").update({ status, updated_at: new Date().toISOString() }).eq("id", id).eq("company_id", company);
      throwIf(error);
    },

    async listCandidates(limit) {
      const { data, error } = await client
        .from("load_candidates")
        .select("id, status, data, first_seen_at")
        .eq("company_id", company)
        .is("deleted_at", null)
        .order("first_seen_at", { ascending: false })
        .limit(limit);
      throwIf(error);
      return ((data ?? []) as Record<string, unknown>[]).map((r) => ({ id: String(r.id), status: String(r.status), data: r.data as Candidate, firstSeenAt: String(r.first_seen_at) }));
    },

    async createDraft(emailMessageId, toAddress, subject, body) {
      const { data, error } = await client
        .from("email_drafts")
        .insert({ company_id: company, email_message_id: emailMessageId, to_address: toAddress, subject, body })
        .select(DRAFT_COLUMNS)
        .single();
      throwIf(error);
      return toDraft(data as Record<string, unknown>);
    },

    async createStandaloneDraft(toAddress, subject, body, mailbox) {
      const { data, error } = await client
        .from("email_drafts")
        .insert({ company_id: company, email_message_id: null, mailbox, to_address: toAddress, subject, body })
        .select(DRAFT_COLUMNS)
        .single();
      throwIf(error);
      return { ...toDraft(data as Record<string, unknown>), mailbox };
    },

    async getDraft(id) {
      const { data, error } = await client.from("email_drafts").select(DRAFT_COLUMNS).eq("company_id", company).eq("id", id).is("deleted_at", null).maybeSingle();
      throwIf(error);
      if (!data) return null;
      const draft = toDraft(data as Record<string, unknown>);
      // The standalone-mailbox column arrives with migration 00086. Read it
      // tolerantly and separately so reply drafts keep working on a database
      // where 00086 has not landed yet (mailbox stays null = "derive it").
      try {
        const { data: mb, error: mbError } = await client.from("email_drafts").select("mailbox").eq("company_id", company).eq("id", id).maybeSingle();
        if (!mbError && mb && ((mb as { mailbox?: unknown }).mailbox === "owner" || (mb as { mailbox?: unknown }).mailbox === "dispatch")) {
          draft.mailbox = (mb as { mailbox: Mailbox }).mailbox;
        }
      } catch {
        /* pre-00086 database: no mailbox column yet - reply behaviour is unaffected */
      }
      return draft;
    },

    async updateDraftBody(id, body) {
      const { data, error } = await client
        .from("email_drafts")
        .update({ body, status: "draft", send_error: null, updated_at: new Date().toISOString() })
        .eq("company_id", company)
        .eq("id", id)
        .in("status", ["draft", "failed"])
        .is("deleted_at", null)
        .select(DRAFT_COLUMNS)
        .maybeSingle();
      throwIf(error);
      return data ? toDraft(data as Record<string, unknown>) : null;
    },

    async claimDraftForSend(id, expectedBody, attemptedAt) {
      const { data, error } = await client
        .from("email_drafts")
        .update({ status: "sending", send_attempted_at: attemptedAt, updated_at: attemptedAt })
        .eq("company_id", company)
        .eq("id", id)
        .eq("body", expectedBody)
        .in("status", ["draft", "failed"])
        .is("deleted_at", null)
        .select("id");
      throwIf(error);
      return (data ?? []).length === 1;
    },

    async markDraftSent(id, sentAt) {
      const { error } = await client.from("email_drafts").update({ status: "sent", sent_at: sentAt, send_error: null, updated_at: sentAt }).eq("company_id", company).eq("id", id);
      throwIf(error);
    },

    async markDraftFailed(id, reason, attemptedAt) {
      const { error } = await client.from("email_drafts").update({ status: "failed", send_error: reason.slice(0, 500), send_attempted_at: attemptedAt, updated_at: attemptedAt }).eq("company_id", company).eq("id", id);
      throwIf(error);
    },

    async insertSent(row) {
      const { data, error } = await client
        .from("email_sent")
        .insert({
          company_id: company,
          mailbox: row.mailbox,
          email_message_id: row.emailMessageId,
          to_address: row.toAddress,
          subject: row.subject,
          body: row.body,
          message_id: row.messageId,
          in_reply_to: row.inReplyTo,
          approved_body_hash: row.approvedBodyHash,
          sent_at: row.sentAt,
          stored_in_sent_folder: row.storedInSentFolder,
        })
        .select(SENT_COLUMNS)
        .single();
      throwIf(error);
      return toSent(data as Record<string, unknown>);
    },

    async listSent(opts = {}) {
      let q = client.from("email_sent").select(SENT_COLUMNS).eq("company_id", company).is("deleted_at", null);
      if (opts.emailMessageId) q = q.eq("email_message_id", opts.emailMessageId);
      const { data, error } = await q.order("sent_at", { ascending: false }).limit(Math.min(opts.limit ?? 20, 50));
      throwIf(error);
      return ((data ?? []) as Record<string, unknown>[]).map(toSent);
    },

    async listSendFailures(limit = 10) {
      const { data, error } = await client
        .from("email_drafts")
        .select(`${DRAFT_COLUMNS}, email_messages!inner(mailbox)`)
        .eq("company_id", company)
        .eq("status", "failed")
        .is("deleted_at", null)
        .order("send_attempted_at", { ascending: false })
        .limit(limit);
      throwIf(error);
      return ((data ?? []) as Record<string, unknown>[]).map((r) => {
        const m = r.email_messages as { mailbox?: string } | { mailbox?: string }[] | null;
        const mailbox = (Array.isArray(m) ? m[0]?.mailbox : m?.mailbox) === "owner" ? "owner" : "dispatch";
        return { ...toDraft(r), mailbox: mailbox as Mailbox };
      });
    },

    async listDrafts(emailMessageId) {
      let q = client.from("email_drafts").select(DRAFT_COLUMNS).eq("company_id", company).is("deleted_at", null).in("status", ["draft", "failed"]);
      if (emailMessageId) q = q.eq("email_message_id", emailMessageId);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(30);
      throwIf(error);
      return ((data ?? []) as Record<string, unknown>[]).map(toDraft);
    },
  };
}

const DRAFT_COLUMNS = "id, email_message_id, to_address, subject, body, status, created_at, send_error, sent_at";
const SENT_COLUMNS = "id, mailbox, email_message_id, to_address, subject, body, message_id, in_reply_to, approved_body_hash, sent_at, stored_in_sent_folder";

const DRAFT_STATUSES: readonly DraftStatus[] = ["draft", "discarded", "sending", "sent", "failed"];

function toDraft(r: Record<string, unknown>): DraftRow {
  return {
    id: String(r.id),
    emailMessageId: (r.email_message_id as string | null) ?? null,
    mailbox: r.mailbox === "owner" ? "owner" : r.mailbox === "dispatch" ? "dispatch" : null,
    toAddress: String(r.to_address),
    subject: String(r.subject),
    body: String(r.body),
    status: (DRAFT_STATUSES as readonly string[]).includes(String(r.status)) ? (r.status as DraftStatus) : "draft",
    createdAt: String(r.created_at),
    sendError: (r.send_error as string | null) ?? null,
    sentAt: (r.sent_at as string | null) ?? null,
  };
}

function toSent(r: Record<string, unknown>): SentRow {
  return {
    id: String(r.id),
    mailbox: r.mailbox === "owner" ? "owner" : "dispatch",
    emailMessageId: (r.email_message_id as string | null) ?? null,
    toAddress: String(r.to_address),
    subject: String(r.subject),
    body: String(r.body),
    messageId: String(r.message_id),
    inReplyTo: (r.in_reply_to as string | null) ?? null,
    approvedBodyHash: String(r.approved_body_hash),
    sentAt: String(r.sent_at),
    storedInSentFolder: Boolean(r.stored_in_sent_folder),
  };
}
