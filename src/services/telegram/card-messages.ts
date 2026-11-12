// Edit-in-place registry for rich cards (owner 2026-11-11): one
// live message per thing. Process-local and best-effort by design -
// the brain store has no message-id column, and this deliberately
// adds NO migration: when the process restarts (or a card was
// dismissed) the lookup misses and the next card simply sends fresh.
// Nothing here is a source of truth; the timeline in the store
// still records every turn in full.

export const CARD_EDIT_MAX_AGE_MS = 48 * 60 * 60 * 1000; // Telegram's edit window.

export interface CardMessageRef {
  messageId: number;
  /** Original send time - the 48h window runs from the first send, not the last edit. */
  sentAtMs: number;
  html: string;
}

const registry = new Map<string, CardMessageRef>();

function registryKey(chatId: number, key: string): string {
  return `${chatId}:${key}`;
}

export function recordCardMessage(chatId: number, key: string, messageId: number, html: string): void {
  const existing = registry.get(registryKey(chatId, key));
  registry.set(registryKey(chatId, key), {
    messageId,
    sentAtMs: existing?.messageId === messageId ? existing.sentAtMs : Date.now(),
    html,
  });
}

export function lookupCardMessage(chatId: number, key: string): CardMessageRef | undefined {
  return registry.get(registryKey(chatId, key));
}

export function forgetCardMessage(chatId: number, key: string): void {
  registry.delete(registryKey(chatId, key));
}

/** Tests only. */
export function clearCardRegistry(): void {
  registry.clear();
}
