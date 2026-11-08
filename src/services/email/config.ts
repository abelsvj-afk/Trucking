// Company inbox configuration (docs/design/abel-email-access.md; docs/design/company-inbox.md section 3). Env only - nothing
// here is a default for a secret. TWO mailboxes (dispatch@ and owner@), each configured independently: one missing or failing
// mailbox never affects the other. Missing user or password = THAT mailbox is OFF, and says so. The password is returned to the
// ONE caller that opens the IMAP connection and is never serialised into a status, a log line or an error message.

export const MAILBOXES = ["dispatch", "owner"] as const;
export type Mailbox = (typeof MAILBOXES)[number];

export const MAILBOX_LABEL: Record<Mailbox, string> = { dispatch: "dispatch@", owner: "owner@" };

export interface EmailConfig {
  mailbox: Mailbox;
  user: string;
  password: string;
  host: string;
  port: number;
  intervalMs: number;
}

export type EmailConfigResult = { ok: true; config: EmailConfig } | { ok: false; reason: string };
type Env = Record<string, string | undefined>;

export const DEFAULT_IMAP_HOST = "imap.ionos.com";
export const DEFAULT_IMAP_PORT = 993;
export const DEFAULT_INTERVAL_MS = 5 * 60_000;
export const MIN_INTERVAL_MS = 60_000;

const ENV_NAMES: Record<Mailbox, { user: string; password: string }> = {
  dispatch: { user: "IONOS_EMAIL_DISPATCH_USER", password: "IONOS_EMAIL_DISPATCH_PASSWORD" },
  owner: { user: "IONOS_EMAIL_OWNER_USER", password: "IONOS_EMAIL_OWNER_PASSWORD" },
};

export function getEmailConfig(mailbox: Mailbox, env: Env = process.env): EmailConfigResult {
  const label = MAILBOX_LABEL[mailbox];
  const names = ENV_NAMES[mailbox];
  const user = (env[names.user] ?? "").trim();
  const password = env[names.password] ?? "";
  if (!user && !password.trim()) return { ok: false, reason: `The ${label} inbox isn't set up on the server (no email login configured).` };
  if (!user) return { ok: false, reason: `The ${label} inbox login is incomplete: the email address is missing.` };
  if (!password.trim()) return { ok: false, reason: `The ${label} inbox login is incomplete: the password is missing.` };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) return { ok: false, reason: `The ${label} inbox email address doesn't look like an email address.` };
  const port = Number(env.IONOS_IMAP_PORT);
  const interval = Number(env.EMAIL_POLL_INTERVAL_MS);
  return {
    ok: true,
    config: {
      mailbox,
      user,
      password,
      host: (env.IONOS_IMAP_HOST ?? "").trim() || DEFAULT_IMAP_HOST,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_IMAP_PORT,
      intervalMs: Number.isFinite(interval) && interval >= MIN_INTERVAL_MS ? interval : DEFAULT_INTERVAL_MS,
    },
  };
}

export function getAllEmailConfigs(env: Env = process.env): Record<Mailbox, EmailConfigResult> {
  return { dispatch: getEmailConfig("dispatch", env), owner: getEmailConfig("owner", env) };
}

/** The mailbox address and server for display - never the password. */
export function describeConfig(c: EmailConfig): { mailbox: Mailbox; user: string; host: string; port: number; intervalMinutes: number } {
  return { mailbox: c.mailbox, user: c.user, host: c.host, port: c.port, intervalMinutes: Math.round(c.intervalMs / 60_000) };
}

// --- Sending (owner decision 2026-11-07; docs/design/abel-email-access.md addendum) -------------------------------------------
// The SAME four IONOS credentials are reused. owner@ sending is active; dispatch@ sending is DORMANT behind a flag, default off.

export const DEFAULT_SMTP_HOST = "smtp.ionos.com";
/** IONOS's documented primary SMTP setting: implicit SSL/TLS on 465 (587 STARTTLS is also offered; set IONOS_SMTP_PORT=587 to use it). */
export const DEFAULT_SMTP_PORT = 465;

export interface SmtpSettings {
  host: string;
  port: number;
  /** true = implicit TLS (465); false = STARTTLS required (587). */
  secure: boolean;
}

export function getSmtpSettings(env: Env = process.env): SmtpSettings {
  const port = Number(env.IONOS_SMTP_PORT);
  const p = Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SMTP_PORT;
  return { host: (env.IONOS_SMTP_HOST ?? "").trim() || DEFAULT_SMTP_HOST, port: p, secure: p === 465 };
}

/** dispatch@ sending is off unless explicitly switched on. owner@ sending needs no flag. */
export function isSendEnabled(mailbox: Mailbox, env: Env = process.env): boolean {
  if (mailbox === "owner") return true;
  return ["1", "true", "yes", "on"].includes((env.EMAIL_SEND_DISPATCH_ENABLED ?? "").trim().toLowerCase());
}

export const DISPATCH_SEND_OFF_REASON = "Dispatch sending isn't switched on. It is built but dormant until the dispatch program is in use (EMAIL_SEND_DISPATCH_ENABLED).";
