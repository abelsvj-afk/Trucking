import {
  deliveryDecision,
  type DeliveryClass,
} from "@/services/research/delivery";
import { getResearchConfig } from "@/services/research/config";
import type { BusinessCreditStore } from "@/services/business-credit/store";
import type {
  BusinessCreditAccount,
  BusinessCreditPaymentState,
  BusinessCreditSignal,
} from "@/types/entities";

/**
 * The Business Credit email watch (brief 2026-11-10;
 * docs/design/business-credit.md §4).
 *
 * Deterministic code-side classification — no model call. For each
 * freshly stored inbox message whose sender matches a tracked
 * vendor's `match_senders` (DATA on the account row):
 *
 *   - a payment signal (missed / invoice / due date / payment made)
 *     updates ONLY the account's payment fields, and only with values
 *     the mail itself states (a due date only from an explicit date,
 *     an amount only from an explicit dollar figure);
 *   - every signal is audit-logged in business_credit_events with the
 *     email_messages row id + server Message-ID;
 *   - the Telegram buzz routes through the EXISTING deliveryDecision:
 *     missed/late is `urgent` (straight through quiet hours and the
 *     driving hold); everything else is `routine` (held, then flushed
 *     by a later watch pass once the gate opens).
 *
 * Status/phase is NEVER changed from mail. A message yields at most
 * one watch event per account (the (account, email) pair dedupes).
 */

export interface WatchMessage {
  /** email_messages row id (uuid). */
  rowId: string;
  /** The server Message-ID header value, when known. */
  serverMessageId: string | null;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  bodyText: string | null;
}

export interface DetectedSignal {
  signal: BusinessCreditSignal;
  dueDate: string | null;
  amountCents: number | null;
}

function senderDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase().trim() : "";
}

/** Sender match against the account's data-driven match_senders. */
export function matchVendorAccount(
  accounts: readonly BusinessCreditAccount[],
  msg: Pick<WatchMessage, "fromAddress">,
): BusinessCreditAccount | null {
  const from = msg.fromAddress.toLowerCase().trim();
  const domain = senderDomain(from);
  for (const account of accounts) {
    for (const raw of account.match_senders) {
      const needle = raw.toLowerCase().trim();
      if (!needle) continue;
      if (needle.includes("@")) {
        if (from === needle) return account;
      } else if (
        domain === needle ||
        domain.endsWith(`.${needle}`)
      ) {
        return account;
      }
    }
  }
  return null;
}

const MISSED_RE =
  /past[\s-]?due|overdue|payment (?:is )?(?:late|missed|overdue)|missed payment|late payment|failed payment|payment (?:was )?declined|delinquent/i;
const PAID_RE =
  /payment (?:received|successful|confirmed|processed|posted|complete)|we received your payment|thanks for your payment|thank you for your payment|payment of \$[\d,]+(?:\.\d{2})? (?:was|has been)/i;
const INVOICE_RE =
  /invoice|statement (?:is )?(?:ready|available)|bill (?:is )?(?:ready|available)|new balance/i;
const DUE_RE =
  /due date|amount due|balance due|payment due|please pay|autopay/i;

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function isoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A due date ONLY when the text states one explicitly. Never guessed. */
export function extractDueDate(text: string): string | null {
  const windowed = text.slice(0, 4000);
  // "due (on) January 5, 2027" / "due by Jan 5, 2027"
  const byName =
    /due[^.\n]{0,24}?\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(
      windowed,
    );
  if (byName) {
    const iso = isoDate(
      Number(byName[3]),
      MONTHS[byName[1]!.toLowerCase()]!,
      Number(byName[2]),
    );
    if (iso) return iso;
  }
  // "due 2027-01-05"
  const byIso = /due[^.\n]{0,24}?\b(\d{4})-(\d{2})-(\d{2})\b/i.exec(windowed);
  if (byIso) {
    const iso = isoDate(Number(byIso[1]), Number(byIso[2]), Number(byIso[3]));
    if (iso) return iso;
  }
  // A bare explicit ISO date near due/invoice wording.
  if (DUE_RE.test(windowed) || INVOICE_RE.test(windowed)) {
    const bare = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(windowed);
    if (bare) {
      const iso = isoDate(Number(bare[1]), Number(bare[2]), Number(bare[3]));
      if (iso) return iso;
    }
  }
  return null;
}

/** An amount ONLY from an explicit dollar figure tied to due/balance/invoice wording. */
export function extractAmountCents(text: string): number | null {
  const m =
    /(?:amount due|balance due|total due|invoice (?:total|amount)|balance)[:\s]*\$([\d,]+(?:\.\d{2})?)/i.exec(
      text,
    ) ?? /\$([\d,]+(?:\.\d{2})?)\s+(?:is )?due/i.exec(text);
  if (!m) return null;
  const dollars = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

/**
 * Classify one message. Order matters: missed/late is checked FIRST
 * so "your payment is past due" can never be read as a routine due
 * date; payment-made beats invoice so a receipt isn't an open bill.
 */
export function detectPaymentSignal(
  msg: Pick<WatchMessage, "subject" | "bodyText">,
): DetectedSignal | null {
  const text = `${msg.subject}\n${msg.bodyText ?? ""}`;
  const dueDate = extractDueDate(text);
  const amountCents = extractAmountCents(text);
  if (MISSED_RE.test(text)) {
    return { signal: "missed", dueDate, amountCents };
  }
  if (PAID_RE.test(text)) {
    return { signal: "payment_made", dueDate: null, amountCents };
  }
  if (INVOICE_RE.test(text)) {
    return { signal: "invoice", dueDate, amountCents };
  }
  if (DUE_RE.test(text) && (dueDate !== null || amountCents !== null)) {
    return { signal: "due_date", dueDate, amountCents };
  }
  return null;
}

/** The payment fields a signal writes — the ONLY fields mail may touch. */
export function paymentPatchFor(
  detected: DetectedSignal,
): {
  payment_state: BusinessCreditPaymentState;
  next_due_date?: string | null;
  amount_due_cents?: number | null;
} {
  switch (detected.signal) {
    case "missed":
      return {
        payment_state: "missed",
        ...(detected.dueDate !== null
          ? { next_due_date: detected.dueDate }
          : {}),
        ...(detected.amountCents !== null
          ? { amount_due_cents: detected.amountCents }
          : {}),
      };
    case "payment_made":
      return {
        payment_state: "paid",
        next_due_date: null,
        amount_due_cents: null,
      };
    case "invoice":
      return {
        payment_state: "invoice_open",
        ...(detected.dueDate !== null
          ? { next_due_date: detected.dueDate }
          : {}),
        ...(detected.amountCents !== null
          ? { amount_due_cents: detected.amountCents }
          : {}),
      };
    case "due_date":
      return {
        payment_state: "due_soon",
        ...(detected.dueDate !== null
          ? { next_due_date: detected.dueDate }
          : {}),
        ...(detected.amountCents !== null
          ? { amount_due_cents: detected.amountCents }
          : {}),
      };
    default:
      return { payment_state: "none" };
  }
}

/** Delivery class for a signal: missed is time-sensitive, the rest routine. */
export function deliveryClassFor(signal: BusinessCreditSignal): DeliveryClass {
  return signal === "missed" ? "urgent" : "routine";
}

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const SIGNAL_WORDS: Record<string, string> = {
  missed: "a MISSED / late payment",
  invoice: "a new invoice",
  due_date: "a payment coming due",
  payment_made: "a payment made",
};

export function composeBuzz(
  account: BusinessCreditAccount,
  detected: DetectedSignal,
  patch: ReturnType<typeof paymentPatchFor>,
): string {
  const bits: string[] = [
    `Business credit — ${account.vendor}: ${SIGNAL_WORDS[detected.signal] ?? "an update"}.`,
  ];
  const due = patch.next_due_date ?? account.next_due_date;
  if (detected.signal !== "payment_made" && due) {
    bits.push(`Due ${due}.`);
  }
  const amount = patch.amount_due_cents ?? null;
  if (amount !== null && amount !== undefined) {
    bits.push(`Amount ${formatMoney(amount)}.`);
  }
  bits.push("Logged on the Business Credit page.");
  return bits.join(" ");
}

export interface WatchDeps {
  store: BusinessCreditStore;
  notify: (text: string) => Promise<boolean>;
  now: () => Date;
}

export interface WatchRunResult {
  matched: number;
  updated: number;
  buzzed: number;
  held: number;
  flushed: number;
}

/**
 * Flush held routine buzzes whose delivery gate has opened, then
 * watch this batch of fresh messages. Best-effort throughout: any
 * failure is swallowed by the caller's poll (the watch never breaks
 * the inbox).
 */
export async function runBusinessCreditWatch(
  deps: WatchDeps,
  messages: readonly WatchMessage[],
): Promise<WatchRunResult> {
  const result: WatchRunResult = {
    matched: 0,
    updated: 0,
    buzzed: 0,
    held: 0,
    flushed: 0,
  };
  const config = getResearchConfig();

  // 1) Flush held buzzes first (routine class re-checked each pass).
  try {
    const held = await deps.store.loadHeldEvents();
    if (held.length > 0) {
      const duty = await deps.store.latestDutyStatus();
      for (const event of held) {
        if (!event.buzz_text) continue;
        const decision = deliveryDecision({
          now: deps.now(),
          deliveryClass: "routine",
          latestDutyStatus: duty,
          config,
        });
        if (!decision.sendNow) continue;
        const ok = await deps.notify(event.buzz_text);
        if (ok) {
          await deps.store.markBuzzSent(event.id, deps.now().toISOString());
          result.flushed += 1;
        }
      }
    }
  } catch {
    // best-effort — the next poll retries
  }

  // 2) Watch the fresh batch.
  const accounts = await deps.store.loadAccounts();
  if (!accounts || accounts.length === 0) return result;
  const duty = await deps.store.latestDutyStatus();

  for (const msg of messages) {
    const account = matchVendorAccount(accounts, msg);
    if (!account) continue;
    result.matched += 1;
    const detected = detectPaymentSignal(msg);
    if (!detected) continue;

    const existing = await deps.store.findWatchEvent(account.id, msg.rowId);
    if (existing) continue; // one watch event per (account, email)

    const patch = paymentPatchFor(detected);
    const before = {
      payment_state: account.payment_state,
      next_due_date: account.next_due_date,
      amount_due_cents: account.amount_due_cents,
    };
    const after = {
      payment_state: patch.payment_state,
      next_due_date:
        patch.next_due_date !== undefined
          ? patch.next_due_date
          : account.next_due_date,
      amount_due_cents:
        patch.amount_due_cents !== undefined
          ? patch.amount_due_cents
          : account.amount_due_cents,
    };
    const changed =
      before.payment_state !== after.payment_state ||
      before.next_due_date !== after.next_due_date ||
      before.amount_due_cents !== after.amount_due_cents;

    const buzz = composeBuzz(account, detected, patch);
    const decision = deliveryDecision({
      now: deps.now(),
      deliveryClass: deliveryClassFor(detected.signal),
      latestDutyStatus: duty,
      config,
    });

    if (changed) {
      await deps.store.applyPaymentUpdate(account.id, patch);
      result.updated += 1;
      // Keep the in-memory row current for later messages in this batch.
      Object.assign(account, after);
    }

    const event = await deps.store.recordEvent({
      account_id: account.id,
      source: "email_watch",
      signal: detected.signal,
      email_message_id: msg.rowId,
      email_server_message_id: msg.serverMessageId,
      summary: `${account.vendor}: ${SIGNAL_WORDS[detected.signal] ?? detected.signal} (from email "${msg.subject}")`,
      detail: { before, after, changed, subject: msg.subject },
      buzz_state: decision.sendNow ? "sent" : "held",
      buzz_text: buzz,
      buzz_sent_at: decision.sendNow ? deps.now().toISOString() : null,
    });

    if (decision.sendNow) {
      const ok = await deps.notify(buzz);
      if (ok) result.buzzed += 1;
      else if (event) {
        // Send failed after the event was recorded as sent — re-hold
        // it so the flush retries instead of the buzz being lost.
        await deps.store.markBuzzHeld(event.id).catch(() => undefined);
        result.held += 1;
      }
    } else {
      result.held += 1;
    }
  }
  return result;
}
