// Research topic presentation (Home News Banner design, 2026-11-02
// §3): the one home for the topic -> emoji map so the Telegram
// delivery copy, the Home banner, and the Research tab can never
// drift apart. Moved here from services/research/delivery.ts, which
// now imports it.

export const TOPIC_EMOJI: Record<string, string> = {
  fuel: "⛽",
  regulation: "⚖️",
  weather: "🌩️",
  rates: "📈",
  market: "📈",
};

export function topicEmoji(topic: string): string {
  return TOPIC_EMOJI[topic] ?? "📰";
}
