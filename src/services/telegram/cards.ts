// Telegram rich cards (owner 2026-11-11): SAME words, better
// display. Presentation ONLY - these helpers detect a summary in
// Abel's already-cleaned plain reply, render it as Telegram HTML,
// and build the inline keyboard that rides on it. They never change
// a word, a digit, a decision, or a delivery class.
//
// Verbatim guard: a card needs a card-shaped reply (an emoji header
// + a trip / pay / HOS marker + at least two labeled fact lines).
// A verbatim read-back (a document, an email, a code) has no such
// header, so it stays plain text. Card formatting itself only adds
// <b> tags - the words inside are byte-identical to the plain text.

export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;

export type CardKind = "load" | "pay" | "hos";

export interface DetectedCard {
  kind: CardKind;
  /** Stable key for edit-in-place: one live message per thing. */
  key: string;
  tripNumber?: string;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
}

export type InlineKeyboard = InlineButton[][];

/** The live app's public base URL (no session in it - the sign-in gate still applies inside the webview). */
export function getTelegramAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.TELEGRAM_APP_URL ?? "https://app.roadtolegacytrucking.com").replace(/\/$/, "");
}

/** The in-app page a card opens. Loads has no trip-number route - the list page is the matching page (the UUID never appears in a reply). */
export function appUrlForCard(kind: CardKind, appUrl: string): string {
  switch (kind) {
    case "load":
      return `${appUrl}/loads`;
    case "pay":
      return `${appUrl}/money/pay`;
    case "hos":
      return `${appUrl}/fleet/hos`;
  }
}

/** Today in his timezone - the HOS card's key, so tomorrow's clocks are a new message, not an edit of today's. */
function todayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const LABELED_LINE = /^(?:\p{Extended_Pictographic}\S*\s+)?[A-Za-z][A-Za-z ]{1,24}:\s+\S/u;
/** A dispatch workup stop line ("Stop 1 · PICKUP: ...") — a structured fact, not prose. */
const STOP_LINE = /^Stop \d+\s*[·•\-–—]/;
/** A numbered list item ("1. Attach the BOL...") — a structured fact, not prose. */
const NUMBERED_ITEM = /^\d+[.)]\s+\S/;

/**
 * How many structured fact lines a reply carries: labeled
 * "Label: value" lines, dispatch workup stop lines, and numbered
 * list items. A reply needs at least two to be a card — one fact
 * is a note, two is a summary.
 */
export function structuredLineCount(plainText: string): number {
  return String(plainText ?? "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return LABELED_LINE.test(t) || STOP_LINE.test(t) || NUMBERED_ITEM.test(t);
    }).length;
}

/**
 * True only for a structured summary: an emoji header naming the
 * kind, a kind marker (trip number / a money figure / HOS clocks),
 * and at least two structured fact lines. Everything else - prose,
 * questions, drafts, verbatim reads - returns null and stays plain.
 *
 * The header requirement is the verbatim guard: a document read
 * back word for word can mention a trip and carry labeled lines,
 * but it never starts with a card header, so it stays plain.
 */
export function detectCard(plainText: string, now: Date = new Date()): DetectedCard | null {
  const lines = String(plainText ?? "").split("\n");
  const first = lines.find((l) => l.trim().length > 0)?.trim() ?? "";
  if (structuredLineCount(plainText) < 2) return null;

  const trip = /Trip (\d{3,6})/.exec(plainText);
  // 🚛 (delivery truck) as well as 🚚 — the model picks either truck,
  // and the owner reads both as "a load".
  if ((first.startsWith("🚚") || first.startsWith("🚛")) && trip) {
    return { kind: "load", key: `load:${trip[1]}`, tripNumber: trip[1] };
  }
  if (first.startsWith("💵") && /\$[\d,]+\.\d{2}/.test(plainText)) {
    return { kind: "pay", key: "pay:latest" };
  }
  if (first.startsWith("🕒") && /hour|driv|window|break|clock/i.test(plainText)) {
    return { kind: "hos", key: `hos:${todayKey(now)}` };
  }
  return null;
}

/** Escapes text for Telegram's HTML parse_mode (&, <, >). */
export function escapeTelegramHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Renders the plain reply as Telegram HTML: the header line bold,
 * each "Label: value" line's label bold. Words, digits, emoji and
 * line breaks are unchanged - stripping the <b> tags returns the
 * input exactly.
 */
export function formatCardHtml(plainText: string): string {
  const lines = String(plainText ?? "").split("\n");
  return lines
    .map((raw, i) => {
      const line = escapeTelegramHtml(raw);
      if (i === 0 && line.trim().length > 0) return `<b>${line.trim()}</b>`;
      const label = /^((?:\p{Extended_Pictographic}\S*\s+)?[A-Za-z][A-Za-z ]{1,24}:)(\s+\S.*)$/u.exec(line);
      if (label) return `<b>${label[1]}</b>${label[2]}`;
      return line;
    })
    .join("\n");
}

/** Splits a card reply into its title (first line) and labeled rows, for the image renderer. */
export function cardRows(plainText: string): { title: string; rows: Array<[string, string]> } {
  const lines = String(plainText ?? "").split("\n");
  const title = lines.find((l) => l.trim().length > 0)?.trim() ?? "";
  const rows: Array<[string, string]> = [];
  for (const line of lines) {
    const m = /^(?:\p{Extended_Pictographic}\S*\s+)?([A-Za-z][A-Za-z ]{1,24}):\s+(.+)$/u.exec(line.trim());
    if (m) rows.push([m[1]!, m[2]!]);
  }
  return { title, rows };
}

/**
 * The buttons on a card. Answers only - never commands, never a
 * write: Open in app (a Telegram Web App button), Yes / No on a
 * proposal (an inline tap for the typed yes/no), Dismiss (hides the
 * buttons; the proposal, if any, stays pending for a typed answer).
 */
export function buildCardKeyboard(
  card: DetectedCard,
  opts: { appUrl: string; proposal: boolean },
): InlineKeyboard {
  const rows: InlineKeyboard = [];
  const openRow: InlineButton[] = [
    { text: "📱 Open in app", web_app: { url: appUrlForCard(card.kind, opts.appUrl) } },
  ];
  if (opts.proposal) {
    rows.push([
      { text: "✅ Yes", callback_data: "yn:yes" },
      { text: "❌ No", callback_data: "yn:no" },
    ]);
    rows.push([...openRow, { text: "✕ Dismiss", callback_data: `dismiss:${card.key}` }]);
  } else {
    rows.push([...openRow, { text: "✕ Dismiss", callback_data: `dismiss:${card.key}` }]);
  }
  return rows;
}
