// Readable Telegram messages (owner 2026-11-07: "I don't like those stars - replace them with emojis ... arrange
// things nicely, clearly, easy to read"; docs/design/bot-messages-and-safety.md section 1).
// Telegram shows plain text, so the model's markdown appeared as literal asterisks. This is the code layer that
// guarantees clean text whatever the model writes; STYLE_RULES is the prompt layer that asks for it up front.
// It only changes presentation: digits, money, ids, URLs and words are never altered. Idempotent - running it on
// its own output changes nothing.

/** Shared prompt block: how every Abel message should look on a phone. */
export const STYLE_RULES =
  "MESSAGE STYLE (he reads you on a phone, in a truck): plain text only - NEVER use asterisks, underscores, pound signs or backticks for style. " +
  "Start with one short emoji header that says what the message is about (for example 🚚 Load, 💵 Pay, ⛽ Fuel, 🧾 Expense, 📅 Schedule, 🛣️ Miles, ✅ Done, ⚠️ Heads up). " +
  "One fact per line as 'emoji Label: value' (📍 From: ..., 📍 To: ..., 📅 Date: ..., 💵 Pay: $..., 🛣️ Miles: ...). " +
  "Put a blank line between groups. Keep lines short. When you list choices, number them. " +
  "Say plainly which of the two kinds of saving happened: 💾 saved to his app (a real record, and which page) or 🧠 remembered (your own note, not an app record).";

const TOPICS: Array<[RegExp, string]> = [
  [/^(?:load|trip|run|freight|lane)s?\b/i, "🚚"],
  [/^(?:pay|paid|payment|payday|paycheck|settlement|statement|earnings?|income|gross|net|rate)\b/i, "💵"],
  [/^(?:fuel|diesel|gas|def)\b/i, "⛽"],
  [/^(?:miles?|mileage|distance|deadhead|loaded)\b/i, "🛣️"],
  [/^(?:date|day|pick-?up|deliver(?:y|ed)?|due|when|week|schedule|appointment)\b/i, "📅"],
  [/^(?:time|hours?|clock|drive|driving|shift|break|cycle|window|eta)\b/i, "🕒"],
  [/^(?:origin|destination|from|to|location|where|address|city|state|stop)\b/i, "📍"],
  [/^(?:truck|trailer|unit|vehicle|tractor)\b/i, "🚛"],
  [/^(?:broker|customer|carrier|dispatcher|driver|contact|employer|person|shipper|receiver)\b/i, "👤"],
  [/^(?:expense|cost|receipt|toll|tolls|repair|maintenance|service|invoice)\b/i, "🧾"],
  [/^(?:note|notes|memo|reminder|remember|memory)\b/i, "📝"],
  [/^(?:document|photo|image|bol|rate ?con|paperwork|file)\b/i, "📄"],
  [/^(?:warning|careful|heads up|caution)\b/i, "⚠️"],
  [/^(?:status|state|result|now)\b/i, "📌"],
];

const startsWithEmoji = (s: string) => /^\s*[\p{Extended_Pictographic}⭐✅❌]/u.test(s);

function topicEmoji(text: string): string | null {
  const t = text.trim();
  for (const [pattern, emoji] of TOPICS) if (pattern.test(t)) return emoji;
  return null;
}

/** Removes markdown emphasis markers but keeps the words. */
function stripEmphasis(line: string): string {
  return line
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^\w])__(.+?)__(?=[^\w]|$)/g, "$1$2")
    // single-star italics: an opening * that touches a word and a closing * that does, not multiplication
    .replace(/(^|[\s(])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1");
}

/** Turns what the model (or any code) wrote into clean, emoji-labelled plain text. */
export function formatReply(text: string): string {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = lines.map((raw) => {
    let line = raw.replace(/[ \t]+$/g, "");

    // Markdown headings -> an emoji header.
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const title = stripEmphasis(heading[1]!).replace(/:\s*$/, "").trim();
      return startsWithEmoji(title) ? title : `${topicEmoji(title) ?? "📌"} ${title}`;
    }

    // Bullets (-, *, •) -> a topic emoji (or a neutral marker), keeping indentation.
    const bullet = /^(\s*)(?:[-*•])\s+(.*)$/.exec(line);
    if (bullet && !/^\s*[-*•]\s*$/.test(line)) {
      const body = stripEmphasis(bullet[2]!);
      if (startsWithEmoji(body)) return `${bullet[1]}${body}`;
      return `${bullet[1]}${topicEmoji(body) ?? "▫️"} ${body}`;
    }

    line = stripEmphasis(line);

    // A bare "Label: value" line gets its topic emoji (a number, "1. ", or an emoji-led line is left alone).
    const label = /^([A-Za-z][A-Za-z ]{1,24}):\s+\S/.exec(line);
    if (label && !startsWithEmoji(line)) {
      const emoji = topicEmoji(label[1]!);
      if (emoji) return `${emoji} ${line}`;
    }
    return line;
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Splits text into chunks Telegram will accept (its hard cap is 4096 chars; 4000 leaves headroom).
 * Breaks on line breaks first, packing whole lines into a chunk while they fit. A single line
 * longer than the limit is hard-split: at the last space at or before the limit when that space
 * sits in the back half of the window (that space is consumed - it appears in no chunk), otherwise
 * exactly at the limit. A cut never lands inside a UTF-16 surrogate pair: if it would, it backs
 * off one char so an emoji is never torn in half. Joining the chunks of a hard-split line with ""
 * reproduces the line exactly, except for the spaces consumed at split points.
 */
export function splitTelegramMessage(text: string, limit = 4000): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  // One hard-split piece off the front of an over-limit line, plus what remains.
  const takePiece = (line: string): { piece: string; rest: string } => {
    const spaceIdx = line.lastIndexOf(" ", limit);
    if (spaceIdx > limit / 2) {
      return { piece: line.slice(0, spaceIdx), rest: line.slice(spaceIdx + 1) };
    }
    let cut = limit;
    const before = line.charCodeAt(cut - 1);
    const after = line.charCodeAt(cut);
    if (cut > 1 && before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      cut -= 1; // the cut would tear a surrogate pair (e.g. an emoji) in half - end one char earlier
    }
    return { piece: line.slice(0, cut), rest: line.slice(cut) };
  };

  for (const rawLine of String(text ?? "").split("\n")) {
    let line = rawLine;
    for (;;) {
      const needed = current ? current.length + 1 + line.length : line.length;
      if (needed <= limit) {
        current = current ? `${current}\n${line}` : line;
        break;
      }
      if (current) {
        flush();
        continue;
      }
      // Current chunk is empty and this line alone is over the limit: hard-split it.
      const { piece, rest } = takePiece(line);
      chunks.push(piece);
      line = rest;
      if (!line) break;
    }
  }
  flush();
  return chunks;
}
