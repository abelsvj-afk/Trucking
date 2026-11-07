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
