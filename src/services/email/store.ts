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

export interface DraftRow {
  id: string;
  emailMessageId: string;
  toAddress: string;
  subject: string;
  body: string;
  status: "draft" | "discarded";
  createdAt: string;
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
  listDrafts(emailMessageId?: string): Promise<DraftRow[]>;
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
        .select("id, email_message_id, to_address, subject, body, status, created_at")
        .single();
      throwIf(error);
      return toDraft(data as Record<string, unknown>);
    },

    async listDrafts(emailMessageId) {
      let q = client.from("email_drafts").select("id, email_message_id, to_address, subject, body, status, created_at").eq("company_id", company).is("deleted_at", null).eq("status", "draft");
      if (emailMessageId) q = q.eq("email_message_id", emailMessageId);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(30);
      throwIf(error);
      return ((data ?? []) as Record<string, unknown>[]).map(toDraft);
    },
  };
}

function toDraft(r: Record<string, unknown>): DraftRow {
  return {
    id: String(r.id),
    emailMessageId: String(r.email_message_id),
    toAddress: String(r.to_address),
    subject: String(r.subject),
    body: String(r.body),
    status: r.status === "discarded" ? "discarded" : "draft",
    createdAt: String(r.created_at),
  };
}
