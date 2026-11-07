// Company inbox configuration (docs/design/company-inbox.md section 3). Env only - nothing here is a default for a
// secret. Missing user or password = the integration is OFF, and says so. The password is returned to the ONE caller that
// opens the IMAP connection and is never serialised into a status, a log line or an error message.

export interface EmailConfig {
  user: string;
  password: string;
  host: string;
  port: number;
  intervalMs: number;
}

export type EmailConfigResult = { ok: true; config: EmailConfig } | { ok: false; reason: string };

export const DEFAULT_IMAP_HOST = "imap.ionos.com";
export const DEFAULT_IMAP_PORT = 993;
export const DEFAULT_INTERVAL_MS = 5 * 60_000;
export const MIN_INTERVAL_MS = 60_000;

export function getEmailConfig(env: Record<string, string | undefined> = process.env): EmailConfigResult {
  const user = (env.IONOS_EMAIL_USER ?? "").trim();
  const password = env.IONOS_EMAIL_PASSWORD ?? "";
  if (!user && !password.trim()) return { ok: false, reason: "The company inbox isn't set up on the server (no email login configured)." };
  if (!user) return { ok: false, reason: "The company inbox login is incomplete: the email address is missing." };
  if (!password.trim()) return { ok: false, reason: "The company inbox login is incomplete: the password is missing." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) return { ok: false, reason: "The company inbox email address doesn't look like an email address." };
  const port = Number(env.IONOS_IMAP_PORT);
  const interval = Number(env.EMAIL_POLL_INTERVAL_MS);
  return {
    ok: true,
    config: {
      user,
      password,
      host: (env.IONOS_IMAP_HOST ?? "").trim() || DEFAULT_IMAP_HOST,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_IMAP_PORT,
      intervalMs: Number.isFinite(interval) && interval >= MIN_INTERVAL_MS ? interval : DEFAULT_INTERVAL_MS,
    },
  };
}

/** The mailbox address and server for display - never the password. */
export function describeConfig(c: EmailConfig): { user: string; host: string; port: number; intervalMinutes: number } {
  return { user: c.user, host: c.host, port: c.port, intervalMinutes: Math.round(c.intervalMs / 60_000) };
}
