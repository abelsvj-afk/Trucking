// Sending (owner decision 2026-11-07; docs/design/abel-email-access.md addendum). ONE function sends: sendApprovedDraft. It is reached only from
// the send_email tool, which is always a PROPOSAL the owner approves, and it re-checks everything itself so a bug upstream cannot send:
//   - the draft exists and is still open (never sent twice; never a discarded draft);
//   - the body hash he approved equals the CURRENT body (an edit after approval blocks the send);
//   - the mailbox is allowed to send (dispatch@ is dormant unless EMAIL_SEND_DISPATCH_ENABLED is on) and has a login;
//   - the recipient is one plain address (no list, no Cc/Bcc, no header injection) - taken from the stored draft, never from model text;
//   - an atomic claim (draft -> sending) so a double yes cannot send twice.
// A failure is classified in plain words, the draft becomes `failed`, and ONE automatic retry happens only for a connection-level failure.

import { createHash, randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import nodemailer from "nodemailer";
import { DISPATCH_SEND_OFF_REASON, getEmailConfig, getSmtpSettings, isSendEnabled, MAILBOX_LABEL, type EmailConfig, type EmailConfigResult, type Mailbox, type SmtpSettings } from "./config";
import { classifySmtpError, scrubSecrets, type SendFailure } from "./errors";
import { appendToSentFolder } from "./imap-append";
import type { EmailStore, SentRow } from "./store";

export const bodyHash = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");
/** The short fingerprint shown with a draft and carried in the approval: the first 12 hex characters of the body's SHA-256. */
export const FINGERPRINT_LENGTH = 12;
export const bodyFingerprint = (body: string): string => bodyHash(body).slice(0, FINGERPRINT_LENGTH);

/** One plain address: no list, no display-name tricks, no whitespace/control characters (header injection). */
export const SINGLE_ADDRESS = /^[^\s@<>,;:"()\[\]\\]+@[^\s@<>,;:"()\[\]\\]+\.[^\s@<>,;:"()\[\]\\]+$/;

export interface Outgoing {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo: string | null;
  references: string | null;
  date: Date;
}

/** A Message-ID the original server gave is a usable thread anchor; one WE generated for a message that had none is not. */
export const isThreadable = (id: string | null | undefined): id is string => Boolean(id) && /^<[^<>\s]+@[^<>\s]+>$/.test(id as string) && !/^<generated-[0-9a-f]+@local>$/.test(id as string);

export function buildOutgoing(args: { from: string; to: string; subject: string; body: string; originalMessageId: string | null; now: Date }): Outgoing {
  const domain = args.from.split("@")[1] ?? "localhost";
  const anchor = isThreadable(args.originalMessageId) ? args.originalMessageId : null;
  return {
    from: args.from,
    to: args.to,
    subject: args.subject.replace(/[\r\n]+/g, " ").trim(),
    text: args.body,
    messageId: `<${randomUUID()}@${domain}>`,
    inReplyTo: anchor,
    references: anchor,
    date: args.now,
  };
}

export function composeRaw(out: Outgoing): Promise<Buffer> {
  const composer = new MailComposer({
    from: out.from,
    to: out.to,
    subject: out.subject,
    text: out.text,
    messageId: out.messageId,
    date: out.date,
    ...(out.inReplyTo ? { inReplyTo: out.inReplyTo, references: out.references ?? out.inReplyTo } : {}),
  });
  return new Promise((resolve, reject) => composer.compile().build((err, message) => (err ? reject(err) : resolve(message))));
}

export interface SendDeps {
  emailStore: EmailStore;
  now: () => Date;
  env?: Record<string, string | undefined>;
  /** Tells the owner (Telegram) about a failure. Best effort. */
  notify?: (text: string) => Promise<boolean>;
  /** Injectable seams (the real ones talk to IONOS). */
  deliver?: (config: EmailConfig, smtp: SmtpSettings, envelope: { from: string; to: string }, raw: Buffer) => Promise<void>;
  appendSent?: (config: EmailConfig, raw: Buffer) => Promise<boolean>;
  getConfig?: (mailbox: Mailbox) => EmailConfigResult;
}

export type SendResult =
  | { ok: true; sent: SentRow; storedInSentFolder: boolean; warning?: string }
  | { ok: false; reason: string; kind: "refused" | SendFailure["kind"] };

const refuse = (reason: string): SendResult => ({ ok: false, reason, kind: "refused" });

/** The real SMTP delivery. The envelope is exactly one sender and one recipient. */
export async function deliverViaSmtp(config: EmailConfig, smtp: SmtpSettings, envelope: { from: string; to: string }, raw: Buffer): Promise<void> {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
  try {
    const info = await transport.sendMail({ envelope: { from: envelope.from, to: [envelope.to] }, raw });
    if (Array.isArray(info.rejected) && info.rejected.length > 0) {
      throw Object.assign(new Error("recipient rejected"), { code: "EENVELOPE", rejected: info.rejected });
    }
  } finally {
    transport.close();
  }
}

export async function sendApprovedDraft(deps: SendDeps, input: { draftId: string; approvedFingerprint: string }): Promise<SendResult> {
  const { emailStore } = deps;
  const env = deps.env ?? process.env;

  const draft = await emailStore.getDraft(input.draftId);
  if (!draft) return refuse("That draft doesn't exist (or was removed). Nothing was sent.");
  if (draft.status === "sent") return refuse("That draft was already sent. It will not be sent twice.");
  if (draft.status === "sending") return refuse("That draft is being sent right now. Nothing more was done.");
  if (draft.status === "discarded") return refuse("That draft was discarded. Nothing was sent.");

  // The approval gate: he approved a specific text. If the draft is not exactly that text any more, it is not approved.
  if (input.approvedFingerprint.length < FINGERPRINT_LENGTH || !bodyHash(draft.body).startsWith(input.approvedFingerprint.toLowerCase())) {
    return refuse("The draft was changed after you approved it, so I did NOT send it. Look at the new text and approve it again.");
  }

  const original = await emailStore.get(draft.emailMessageId);
  if (!original) return refuse("The message this replies to is no longer in the inbox. Nothing was sent.");
  const mailbox = original.mailbox;
  if (!isSendEnabled(mailbox, env)) return refuse(DISPATCH_SEND_OFF_REASON);
  const configResult = (deps.getConfig ?? ((m: Mailbox) => getEmailConfig(m, env)))(mailbox);
  if (!configResult.ok) return refuse(`${configResult.reason} Nothing was sent.`);
  const config = configResult.config;

  if (!SINGLE_ADDRESS.test(draft.toAddress)) return refuse("The recipient isn't a single valid email address, so nothing was sent.");
  if (draft.subject.trim().length === 0 || draft.body.trim().length === 0) return refuse("The draft needs a subject and a body. Nothing was sent.");

  const attemptedAt = deps.now().toISOString();
  if (!(await emailStore.claimDraftForSend(draft.id, draft.body, attemptedAt))) {
    return refuse("The draft changed or was already being sent, so I did not send it. Nothing was sent.");
  }

  const outgoing = buildOutgoing({ from: config.user, to: draft.toAddress, subject: draft.subject, body: draft.body, originalMessageId: original.messageId, now: deps.now() });
  const smtp = getSmtpSettings(env);
  const deliver = deps.deliver ?? deliverViaSmtp;
  let raw: Buffer;
  try {
    raw = await composeRaw(outgoing);
  } catch {
    await emailStore.markDraftFailed(draft.id, "The message couldn't be built.", attemptedAt);
    return { ok: false, kind: "other", reason: "The message couldn't be built, so nothing was sent." };
  }

  let failure: SendFailure | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await deliver(config, smtp, { from: config.user, to: draft.toAddress }, raw);
      failure = null;
      break;
    } catch (err) {
      failure = classifySmtpError(err, smtp.host);
      console.error(`[email] ${mailbox} send failed (${failure.kind})`, scrubSecrets(err instanceof Error ? err.message : "error", [config.password]).slice(0, 120));
      if (!failure.retryable) break; // ONE retry, and only for a connection-level failure
    }
  }

  if (failure) {
    await emailStore.markDraftFailed(draft.id, failure.message, attemptedAt).catch(() => undefined);
    const reason = `${MAILBOX_LABEL[mailbox]} send failed: ${failure.message}`;
    if (deps.notify) await deps.notify(`⚠️ ${reason}`).catch(() => false);
    return { ok: false, kind: failure.kind, reason };
  }

  // Sent. From here the message is out; every step below only records it, and none can undo or repeat the send.
  const storedInSentFolder = await (deps.appendSent ?? appendToSentFolder)(config, raw).catch(() => false);
  const sentAt = deps.now().toISOString();
  let sent: SentRow;
  try {
    sent = await emailStore.insertSent({
      mailbox,
      emailMessageId: original.id,
      toAddress: draft.toAddress,
      subject: outgoing.subject,
      body: draft.body,
      messageId: outgoing.messageId,
      inReplyTo: outgoing.inReplyTo,
      approvedBodyHash: bodyHash(draft.body),
      sentAt,
      storedInSentFolder,
    });
    await emailStore.markDraftSent(draft.id, sentAt);
  } catch (err) {
    console.error("[email] message SENT but the record could not be saved", err instanceof Error ? err.name : "error");
    return {
      ok: true,
      storedInSentFolder,
      warning: "The message WAS sent, but I couldn't save the record of it. Don't send it again.",
      sent: { id: "", mailbox, emailMessageId: original.id, toAddress: draft.toAddress, subject: outgoing.subject, body: draft.body, messageId: outgoing.messageId, inReplyTo: outgoing.inReplyTo, approvedBodyHash: bodyHash(draft.body), sentAt, storedInSentFolder },
    };
  }
  return {
    ok: true,
    sent,
    storedInSentFolder,
    ...(storedInSentFolder ? {} : { warning: "It was sent and recorded here, but the copy couldn't be added to the mailbox's Sent folder." }),
  };
}
