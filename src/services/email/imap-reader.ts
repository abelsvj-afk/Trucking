// Read-only IMAP access to the company inbox (docs/design/company-inbox.md section 4).
// The ONLY server operations this file may perform are the ones on ImapSession: open the INBOX read-only, search,
// fetch, close. There is deliberately no delete / move / copy / flag / append / expunge in the interface, and a test scans
// this source so one cannot be added without failing the build.

import { ImapFlow } from "imapflow";
import type { EmailConfig } from "./config";
import { classifyImapError, type Classified as ImapFailure } from "./errors";

export const MAX_PER_POLL = 25;
export const FIRST_RUN_DAYS = 7;

export interface RawMessage {
  uid: number;
  source: Buffer;
  internalDate: Date | null;
}

/** The allowlist. Anything the mailbox server can be asked to do must appear here. */
export interface ImapSession {
  /** Opens INBOX read-only (IMAP EXAMINE). Returns the mailbox's UIDVALIDITY. */
  openInboxReadOnly(): Promise<{ uidValidity: string }>;
  /** UIDs of messages received on/after `since`, ascending. */
  searchSince(since: Date): Promise<number[]>;
  /** UIDs greater than or equal to `uid`, ascending. */
  searchFromUid(uid: number): Promise<number[]>;
  /** Fetches full sources without touching flags (BODY.PEEK). */
  fetchSources(uids: number[]): Promise<RawMessage[]>;
  close(): Promise<void>;
}

export interface PollCursor {
  uidvalidity: string | null;
  lastUid: number;
}

export interface ReadResult {
  uidvalidity: string;
  messages: RawMessage[];
  /** The cursor value to store after every message in `messages` has been processed. */
  nextLastUid: number;
  /** True when more mail is waiting beyond this batch. */
  more: boolean;
}

/** Decides which mail to read, oldest first and at most `max`, given the stored cursor. Pure apart from the session. */
export async function readNewMail(session: ImapSession, cursor: PollCursor, now: Date, max = MAX_PER_POLL): Promise<ReadResult> {
  const { uidValidity } = await session.openInboxReadOnly();
  const reset = cursor.uidvalidity !== uidValidity;
  const lastUid = reset ? 0 : cursor.lastUid;
  // First run, or the mailbox was rebuilt (UIDVALIDITY changed): last 7 days only, never the whole history.
  const uids = lastUid > 0 ? await session.searchFromUid(lastUid + 1) : await session.searchSince(new Date(now.getTime() - FIRST_RUN_DAYS * 86_400_000));
  // "UID n:*" always returns the newest message even when it is older than n, so filter client-side.
  const fresh = [...new Set(uids)].filter((u) => u > lastUid).sort((a, b) => a - b);
  const batch = fresh.slice(0, max);
  const messages = batch.length ? await session.fetchSources(batch) : [];
  messages.sort((a, b) => a.uid - b.uid);
  const highest = messages.length ? messages[messages.length - 1]!.uid : lastUid;
  return { uidvalidity: uidValidity, messages, nextLastUid: highest, more: fresh.length > batch.length };
}

/** The real session over imapflow. One short-lived connection per poll. */
export async function openImapSession(config: EmailConfig): Promise<ImapSession> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    logger: false,
    emitLogs: false,
    socketTimeout: 60_000,
    greetingTimeout: 20_000,
    connectionTimeout: 20_000,
  });
  client.on("error", () => {
    /* surfaced through the rejected operation; an unhandled 'error' event must never crash the process */
  });
  await client.connect();
  let lock: { release: () => void } | null = null;
  return {
    async openInboxReadOnly() {
      lock = await client.getMailboxLock("INBOX", { readOnly: true });
      const mb = client.mailbox;
      return { uidValidity: String(mb && typeof mb === "object" ? mb.uidValidity : "") };
    },
    async searchSince(since) {
      const r = await client.search({ since }, { uid: true });
      return Array.isArray(r) ? r : [];
    },
    async searchFromUid(uid) {
      const r = await client.search({ uid: `${uid}:*` }, { uid: true });
      return Array.isArray(r) ? r : [];
    },
    async fetchSources(uids) {
      const out: RawMessage[] = [];
      for await (const m of client.fetch(uids.join(","), { uid: true, source: true, internalDate: true }, { uid: true })) {
        if (m.source) out.push({ uid: m.uid, source: m.source, internalDate: m.internalDate ? new Date(m.internalDate) : null });
      }
      return out;
    },
    async close() {
      try {
        lock?.release();
      } finally {
        await client.logout().catch(() => client.close());
      }
    },
  };
}

/** Runs `fn` with a session and always closes it. A failure comes back classified in plain words, never thrown raw. */
export async function withImapSession<T>(
  config: EmailConfig,
  fn: (s: ImapSession) => Promise<T>,
  open: (c: EmailConfig) => Promise<ImapSession> = openImapSession,
): Promise<{ ok: true; value: T } | { ok: false; failure: ImapFailure }> {
  let session: ImapSession | null = null;
  try {
    session = await open(config);
    return { ok: true, value: await fn(session) };
  } catch (err) {
    return { ok: false, failure: classifyImapError(err, config.host) };
  } finally {
    if (session) await session.close().catch(() => undefined);
  }
}
