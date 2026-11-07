// Turning a raw message into what Abel stores (docs/design/company-inbox.md sections 4-5). Outside content is
// UNTRUSTED: HTML is converted to text and never rendered, control/bidi characters are stripped, length is capped, links
// are never followed and attachments are never downloaded or interpreted (their names are noted).

import { createHash } from "node:crypto";
import { simpleParser, type AddressObject } from "mailparser";

export const MAX_BODY_CHARS = 20_000;

export interface ParsedEmail {
  messageId: string;
  fromAddress: string | null;
  fromName: string | null;
  replyTo: string | null;
  toAddresses: string | null;
  subject: string;
  receivedAt: string;
  bodyText: string;
  attachments: { name: string; type: string | null; bytes: number | null }[];
}

/** Strips control, zero-width and bidi-override characters; collapses runs of blank lines; caps the length. */
export function cleanBody(text: string | null | undefined, max = MAX_BODY_CHARS): string {
  const t = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > max ? `${t.slice(0, max)}\n[... message cut at ${max} characters]` : t;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

/** HTML to plain text for reading. Never rendered: script/style/head are dropped, tags removed, entities decoded, links not followed. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table|ul|ol)\s*>/gi, "\n")
    .replace(/<\/(td|th)\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ");
}

const first = (a: AddressObject | AddressObject[] | undefined) => (Array.isArray(a) ? a[0] : a)?.value?.[0];
const list = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value.map((v) => v.address).filter(Boolean)).join(", ") || null;

/** The server's Message-ID, or a stable hash of from + date + subject when it is missing. */
export function messageKey(messageId: string | undefined | null, from: string | null, date: string, subject: string): string {
  const id = (messageId ?? "").trim();
  if (id) return id.slice(0, 500);
  return `<generated-${createHash("sha256").update(`${from ?? ""}|${date}|${subject}`).digest("hex").slice(0, 32)}@local>`;
}

export async function parseRaw(source: Buffer | string, fallbackDate: Date): Promise<ParsedEmail> {
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipHtmlToText: false });
  const from = first(parsed.from);
  const reply = first(parsed.replyTo);
  const received = (parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : fallbackDate).toISOString();
  const subject = cleanBody(parsed.subject ?? "", 300).replace(/\n/g, " ") || "(no subject)";
  const body = parsed.text && parsed.text.trim() ? parsed.text : typeof parsed.html === "string" ? htmlToPlain(parsed.html) : "";
  return {
    messageId: messageKey(parsed.messageId, from?.address ?? null, received, subject),
    fromAddress: from?.address?.toLowerCase() ?? null,
    fromName: from?.name ? cleanBody(from.name, 120).replace(/\n/g, " ") : null,
    replyTo: reply?.address?.toLowerCase() ?? null,
    toAddresses: list(parsed.to),
    subject,
    receivedAt: received,
    bodyText: cleanBody(body),
    attachments: (parsed.attachments ?? []).slice(0, 20).map((a) => ({
      name: cleanBody(a.filename ?? "(unnamed)", 160).replace(/\n/g, " "),
      type: a.contentType ?? null,
      bytes: typeof a.size === "number" ? a.size : null,
    })),
  };
}
