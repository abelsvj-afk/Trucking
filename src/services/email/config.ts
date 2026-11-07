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
