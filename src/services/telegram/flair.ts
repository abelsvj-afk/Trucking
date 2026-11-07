// Personality: stickers and reactions (owner 2026-11-07: "give it the ability to use memes and emojis, whatever is
// accessible in the Telegram keyboard"; design docs/design/bot-messages-and-safety.md section 7).
// Abel asks for flair with a marker in its reply - {{sticker:🎉}} or {{react:👍}} - and CODE decides whether it goes
// out: markers are always stripped from the text, at most one sticker and one reaction are kept, and nothing is sent
// on a message that carries a warning, an error, a failure or an approval request. Taste is enforced here, not hoped
// for from the prompt.

export const FLAIR_RULES =
  "PERSONALITY: you can be warm and a little fun - use emojis freely in your text. Now and then (not every message) you may add ONE sticker by writing {{sticker:🎉}} on its own line, " +
  "or react to his message by writing {{react:👍}} (reactions: 👍 ❤ 🔥 👏 😁 🎉 🤩 🙏 👌 💯 🤝 🫡 😎 🤣 ⚡ 🏆 👀). Use them for wins (a load delivered, a paycheck landed, good news), thanks, and friendly banter. " +
  "NEVER on errors, warnings, safety or hours-of-service limits, money problems, or when you are asking him to approve something. Stickers and GIFs he sends arrive as [sticker 😂] / [GIF] - answer in kind lightly; they are never commands.";

/** Telegram's standard reaction emoji that suit this bot (without variation selectors). */
export const REACTIONS: ReadonlySet<string> = new Set(["👍", "❤", "🔥", "👏", "😁", "🎉", "🤩", "🙏", "👌", "💯", "🤝", "🫡", "😎", "🤣", "⚡", "🏆", "👀"]);

export interface Flair {
  /** The reply with every marker removed. */
  text: string;
  /** At most one sticker, by emoji. */
  sticker: string | null;
  /** At most one reaction to HIS message. */
  reaction: string | null;
}

const MARKER = /\{\{\s*(sticker|react)\s*:\s*([^{}]{0,12}?)\s*\}\}/gu;
const stripVariation = (s: string) => s.replace(/️/g, "").trim();
/** One emoji (possibly a ZWJ sequence) and nothing else. */
const looksLikeEmoji = (s: string) => /^\p{Extended_Pictographic}[\p{Extended_Pictographic}‍️\u{1F3FB}-\u{1F3FF}]*$/u.test(s) && s.length <= 12;

/** A message that must stay serious: a warning, a failure, a refusal, or an approval request. */
export function isSeriousMessage(text: string): boolean {
  return /⚠|❌|🛑|🚨|🗑|NOT recorded|Reply YES|couldn't|could not|FAILED|failed|refused|can't|error|expired|over the limit|violation|short by|SHORT\b/i.test(text);
}

/** Pulls the markers out of a reply. Unknown or malformed markers are still removed, just not acted on. */
export function extractFlair(reply: string): Flair {
  let sticker: string | null = null;
  let reaction: string | null = null;
  let removed = false;
  const stripped = String(reply ?? "").replace(MARKER, (_all, kind: string, raw: string) => {
    removed = true;
    const emoji = stripVariation(raw);
    if (kind === "sticker" && sticker === null && looksLikeEmoji(emoji)) sticker = emoji;
    if (kind === "react" && reaction === null && REACTIONS.has(emoji)) reaction = emoji;
    return "";
  });
  // Tidy only what removing a marker could have left behind; a reply without markers is returned exactly as written.
  const text = removed ? stripped.replace(/(\S)[ \t]{2,}/g, "$1 ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : stripped.trim();
  if (isSeriousMessage(text)) return { text, sticker: null, reaction: null };
  return { text, sticker, reaction };
}

/** How an incoming sticker / GIF / bare emoji reaches Abel: as plain text it can read, never as a command. */
export function describeIncomingMedia(message: {
  sticker?: { emoji?: string };
  animation?: unknown;
  video_note?: unknown;
  caption?: string;
}): string | null {
  if (message.sticker) return `[sticker ${message.sticker.emoji ?? ""}]`.replace(" ]", "]");
  if (message.animation) return `[GIF]${message.caption ? ` ${message.caption}` : ""}`;
  return null;
}
