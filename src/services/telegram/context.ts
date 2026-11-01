// Driver MVP bot intelligence (docs/design/driver-mvp.md §6). Pure
// helpers for the Telegram bot: message routing, memory retrieval,
// and prompt-context assembly. The standing rule for everything here:
// context is assembled by CODE and injected into every prompt - never
// left for the model to decide to fetch. These functions are pure so
// the rule is unit-testable.

import type { HosSummary } from "@/lib/hos";

export type TelegramIntent = "dispatch" | "remember" | "instruction" | "chat";

const SPANISH_MARKERS = [
  "hola", "gracias", "necesito", "llega", "llegar", "mañana", "carga",
  "camión", "camion", "recoger", "entrega", "quiero", "puedes", "estás",
  "estas", "dónde", "donde", "cuándo", "cuando", "por favor", "buenos",
  "buenas", "señor", "senor", "tarde", "temprano", "listo", "hora",
];

function looksSpanish(text: string): boolean {
  const lower = ` ${text.toLowerCase()} `;
  if (lower.includes("¿") || lower.includes("¡")) return true;
  let hits = 0;
  for (const marker of SPANISH_MARKERS) {
    if (lower.includes(` ${marker}`) || lower.includes(marker)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

/**
 * Routing for one allowlisted private-chat message. Deliberately
 * simple and predictable (v1): forwards are always dispatch; explicit
 * "remember:"/"instruction:" prefixes are capture; text that reads as
 * Spanish goes to the dispatch helper (in this owner's world, Spanish
 * text is almost always a message from his contacts); everything else
 * is conversation with the bot.
 */
export function classifyTelegramText(text: string, isForwarded: boolean): TelegramIntent {
  const trimmed = text.trim();
  if (isForwarded) return "dispatch";
  if (/^remember\b/i.test(trimmed)) return "remember";
  if (/^(instruction|always)\b/i.test(trimmed)) return "instruction";
  if (looksSpanish(trimmed)) return "dispatch";
  return "chat";
}

/** Strips the capture prefix from a remember/instruction message. */
export function stripCapturePrefix(text: string): string {
  return text.trim().replace(/^(remember|instruction)\s*:\s*/i, "").replace(/^always\s+/i, "Always ");
}

/** An expense-flavored dictation is captured as a hint, never booked. */
export function memoryKindFor(text: string): "fact" | "expense_hint" {
  return /\$|\b(spent|paid|fuel|diesel|gallon|scale|toll|parking)\b/i.test(text)
    ? "expense_hint"
    : "fact";
}

export interface BotMemoryRow {
  // person_profile / business_fact arrive with the Job Brain (§12,
  // migration 00028) - structured profiles of the people he works
  // with and how his business runs, in services/bot/people.ts format.
  // game_assumption arrives with the Gaming System (migration
  // 00026): a standing assumption override for the plan engine, in
  // JSON - machine data for the engine, NOT conversational memory,
  // and excluded from pickRelevantMemories below for that reason.
  kind:
    | "fact"
    | "note"
    | "expense_hint"
    | "instruction"
    | "person_profile"
    | "business_fact"
    | "game_assumption";
  content: string;
  created_at: string;
}

const STOP_WORDS = new Set([
  "what", "when", "where", "which", "does", "have", "this", "that", "with",
  "from", "about", "much", "many", "week", "today", "there", "their", "them",
]);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9áéíóúñ ]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w)),
  );
}

/**
 * v1 retrieval - deliberately simple, and documented as such:
 * instructions always come back in full (separately), and for the
 * rest, keyword overlap with the current message ranks first, filled
 * out with the most recent memories. No embeddings, no model choice.
 */
export function pickRelevantMemories(
  memories: BotMemoryRow[],
  query: string,
  limit = 8,
): BotMemoryRow[] {
  const queryWords = keywords(query);
  const nonInstructions = memories.filter((m) => m.kind !== "instruction" && m.kind !== "game_assumption");

  const scored = nonInstructions.map((memory, index) => {
    const words = keywords(memory.content);
    let score = 0;
    for (const w of words) if (queryWords.has(w)) score += 1;
    return { memory, index, score };
  });

  const matched = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((s) => s.memory);

  const recent = [...nonInstructions]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 3);

  const out: BotMemoryRow[] = [];
  for (const m of [...matched, ...recent]) {
    if (!out.includes(m)) out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

export function instructionMemories(memories: BotMemoryRow[]): BotMemoryRow[] {
  return memories.filter((m) => m.kind === "instruction");
}

export interface CompanySnapshot {
  activeLoads: {
    origin: string;
    destination: string;
    status: string;
    pickup_date: string | null;
    delivery_date: string | null;
    rate_cents: number | null;
  }[];
  currentDutyStatus: string | null;
  hos: HosSummary | null;
  expensesLast7DaysCents: number;
  fuelLast7DaysCents: number;
  contacts: {
    brokers: { names: string[]; total: number };
    customers: { names: string[]; total: number };
    drivers: { names: string[]; total: number };
  };
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, "0")}m`;
}

/**
 * The company snapshot as prompt text. Every number in here comes
 * from a query result assembled by the store - if a figure appears in
 * a bot answer, it traces to a line in this block.
 */
export function formatCompanySnapshot(snapshot: CompanySnapshot): string {
  const lines: string[] = ["COMPANY SNAPSHOT (live data from his records - the only source for numbers):"];

  if (snapshot.activeLoads.length === 0) {
    lines.push("Active loads: none on file.");
  } else {
    lines.push("Active loads:");
    for (const load of snapshot.activeLoads) {
      lines.push(
        `- ${load.origin} → ${load.destination} (${load.status}` +
          `${load.pickup_date ? `, pickup ${load.pickup_date}` : ""}` +
          `${load.delivery_date ? `, delivery ${load.delivery_date}` : ""}` +
          `${load.rate_cents != null ? `, rate ${dollars(load.rate_cents)}` : ""})`,
      );
    }
  }

  if (snapshot.hos) {
    lines.push(
      `Duty now: ${snapshot.currentDutyStatus ?? "no status logged"}. ` +
        `Paper-log helper figures (not the ELD): driving in current 14h window ${formatMinutes(snapshot.hos.drivingMinutesInWindow)} of 11h; ` +
        `window elapsed ${formatMinutes(snapshot.hos.windowElapsedMinutes)} of 14h; ` +
        `driving since last 30-min break ${formatMinutes(snapshot.hos.drivingMinutesSinceBreak)} of 8h; ` +
        `on duty in last 8 days ${formatMinutes(snapshot.hos.onDutyMinutesLast8Days)} of 70h.`,
    );
  } else {
    lines.push("Duty/hours: no duty logs on file yet.");
  }

  lines.push(
    `Last 7 days: expenses ${dollars(snapshot.expensesLast7DaysCents)}, fuel purchases ${dollars(snapshot.fuelLast7DaysCents)} (as recorded in the app).`,
  );

  const c = snapshot.contacts;
  lines.push(
    `Contacts on file: brokers (${c.brokers.total}): ${c.brokers.names.join(", ") || "none"}; ` +
      `customers (${c.customers.total}): ${c.customers.names.join(", ") || "none"}; ` +
      `drivers (${c.drivers.total}): ${c.drivers.names.join(", ") || "none"}.`,
  );

  return lines.join("\n");
}

/** The context block attached to a dispatch-helper call from the bot. */
export function buildDispatchContext(
  snapshotText: string | null,
  instructions: BotMemoryRow[],
  memories: BotMemoryRow[],
): string | undefined {
  const parts: string[] = [];
  if (instructions.length > 0) {
    parts.push(
      "OWNER'S STANDING INSTRUCTIONS (always honor these):\n" +
        instructions.map((m) => `- ${m.content}`).join("\n"),
    );
  }
  if (snapshotText) parts.push(snapshotText);
  if (memories.length > 0) {
    parts.push("REMEMBERED FACTS:\n" + memories.map((m) => `- ${m.content}`).join("\n"));
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
