// The honest health of the company inbox (docs/design/company-inbox.md section 8). "Connected" requires a poll that
// succeeded within the last three intervals - a green light never sits on a dead connection.

import { getAllEmailConfigs, describeConfig, MAILBOXES, MAILBOX_LABEL, type EmailConfigResult, type Mailbox } from "./config";
import type { PollState } from "./store";

export type EmailHealth = "off" | "waiting" | "connected" | "stale" | "failing";

export interface EmailStatus {
  mailbox: Mailbox;
  health: EmailHealth;
  /** Plain words for the owner. */
  message: string;
  /** The mailbox's address (never the password); null when OFF. */
  address: string | null;
  lastOkAt: string | null;
  lastErrorKind: string | null;
  intervalMinutes: number | null;
}

const FAIL_WORDS: Record<string, string> = {
  auth: "Email login failed - the password may have changed, or the mailbox login was rejected.",
  network: "Can't reach the mail server right now.",
  tls: "The mail server's security certificate was refused.",
  other: "The last mailbox poll failed for a reason I can't classify.",
};

export function buildEmailStatus(mailbox: Mailbox, configResult: EmailConfigResult, state: PollState | null, now: Date, etLabel: (iso: string) => string): EmailStatus {
  if (!configResult.ok) {
    return { mailbox, health: "off", message: configResult.reason, address: null, lastOkAt: null, lastErrorKind: null, intervalMinutes: null };
  }
  const d = describeConfig(configResult.config);
  const base = { mailbox, address: d.user, intervalMinutes: d.intervalMinutes, lastOkAt: state?.lastOkAt ?? null, lastErrorKind: state?.lastErrorKind ?? null };
  if (state?.lastErrorKind && (!state.lastOkAt || (state.lastErrorAt && state.lastErrorAt >= state.lastOkAt))) {
    return { ...base, health: "failing", message: `${FAIL_WORDS[state.lastErrorKind] ?? FAIL_WORDS.other}${state.lastOkAt ? ` Last good read: ${etLabel(state.lastOkAt)}.` : " It has never read mail successfully."}` };
  }
  if (!state?.lastOkAt) return { ...base, health: "waiting", message: "Set up, waiting for the first check of the mailbox." };
  const age = now.getTime() - Date.parse(state.lastOkAt);
  if (age > 3 * configResult.config.intervalMs) {
    return { ...base, health: "stale", message: `No successful read since ${etLabel(state.lastOkAt)} - the inbox checker may have stopped.` };
  }
  return { ...base, health: "connected", message: `Connected. Last good read: ${etLabel(state.lastOkAt)}.` };
}

/** Both mailboxes, each reported on its own - one failing never hides or changes the other. */
export function buildAllStatuses(
  states: Record<Mailbox, PollState | null>,
  now: Date,
  etLabel: (iso: string) => string,
  configs: Record<Mailbox, EmailConfigResult> = getAllEmailConfigs(),
): EmailStatus[] {
  return MAILBOXES.map((m) => buildEmailStatus(m, configs[m], states[m], now, etLabel));
}

export const mailboxName = (m: Mailbox): string => MAILBOX_LABEL[m];
