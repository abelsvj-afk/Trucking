// Telegram burst collector (owner repairs, 2026-11-03). The
// owner's headline complaint: forward a 20-message group
// conversation to Abel and get 20 individual replies back. This
// collector is the fix's timing half: text updates for one chat
// are held briefly and flushed as ONE bundle turn.
//
// The shape rules (no commands, ever - batching is inferred from
// traffic, never asked for):
// - A FORWARDED message always collects. Forwards arrive as a
//   burst by nature (Telegram delivers a forwarded conversation
//   as N separate updates), so the first forward opens a bundle
//   and each further arrival EXTENDS the wait by the quiet
//   window below - the bundle flushes only once the burst has
//   actually stopped.
// - A NON-forward message opens a bundle in "detect" mode with
//   only the sub-second grace below: if nothing else arrives, it
//   flushes alone (a lone message pays the grace, never the
//   quiet window - that is the singleton latency contract). A
//   second arrival inside the grace promotes the bundle to
//   collecting, with the quiet window extending per arrival.
// - A hard max wait caps a never-ending trickle: the bundle
//   flushes at the cap even if items keep arriving.
//
// Dedup stays exact: the update_id claim (Lane 1 B-2) happens in
// dispatch-bot BEFORE an item reaches this collector, and the
// collector itself drops a repeated update_id inside a pending
// bundle as a second line of defense. If a flush fails, the
// error handler receives the bundle's items so the caller can
// release every claim (CD-6 semantics, widened to the bundle).

/** Quiet window after the last arrival of a burst before the bundle flushes. Tunable. */
export const TELEGRAM_FORWARD_BURST_QUIET_MS = 3_000;

/** Burst-detection grace for a lone non-forward message - the only delay a singleton ever pays. Tunable. */
export const TELEGRAM_BURST_DETECTION_GRACE_MS = 750;

/** Hard cap: a bundle flushes this long after its first item even if arrivals continue. Tunable. */
export const TELEGRAM_BURST_MAX_WAIT_MS = 30_000;

/** Size cap: a bundle flushes immediately at this many items, so a composed turn stays a size the models can work. Tunable. */
export const TELEGRAM_BURST_MAX_ITEMS = 50;

export interface TelegramBurstItem {
  updateId?: number;
  text: string;
  isForwarded: boolean;
  /** Who the forward came from, when Telegram's metadata names a source (display/context only). */
  sourceLabel?: string | null;
  /** True when the text arrived as a transcribed voice note. */
  voiceNote?: boolean;
}

export type TelegramBurstFlush = (items: TelegramBurstItem[]) => Promise<void>;
export type TelegramBurstErrorHandler = (
  items: TelegramBurstItem[],
  error: unknown,
) => Promise<void> | void;

export interface TelegramBurstScheduler {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

interface PendingBundle {
  items: TelegramBurstItem[];
  flush: TelegramBurstFlush;
  onError?: TelegramBurstErrorHandler;
  startedAt: number;
  collecting: boolean;
  timer: unknown;
}

export interface TelegramBurstCollector {
  /**
   * Adds one item to the chat's pending bundle (opening one when
   * none is pending) and (re)schedules the flush. Returns the
   * bundle size after the add.
   */
  enqueue: (
    key: string,
    item: TelegramBurstItem,
    flush: TelegramBurstFlush,
    onError?: TelegramBurstErrorHandler,
  ) => number;
  /** True while a bundle is pending for the chat. */
  hasPending: (key: string) => boolean;
}

export function createTelegramBurstCollector(
  options: {
    scheduler?: TelegramBurstScheduler;
    /** Injectable clock for tests; defaults to Date.now. */
    now?: () => number;
    quietMs?: number;
    detectionGraceMs?: number;
    maxWaitMs?: number;
    maxItems?: number;
  } = {},
): TelegramBurstCollector {
  const scheduler: TelegramBurstScheduler = options.scheduler ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const now = options.now ?? (() => Date.now());
  const quietMs = options.quietMs ?? TELEGRAM_FORWARD_BURST_QUIET_MS;
  const detectionGraceMs = options.detectionGraceMs ?? TELEGRAM_BURST_DETECTION_GRACE_MS;
  const maxWaitMs = options.maxWaitMs ?? TELEGRAM_BURST_MAX_WAIT_MS;
  const maxItems = options.maxItems ?? TELEGRAM_BURST_MAX_ITEMS;
  const pending = new Map<string, PendingBundle>();

  const schedule = (key: string, bundle: PendingBundle, delay: number) => {
    if (bundle.timer !== null && bundle.timer !== undefined) scheduler.clearTimeout(bundle.timer);
    bundle.timer = scheduler.setTimeout(() => {
      void flushBundle(key);
    }, delay);
  };

  const flushBundle = async (key: string): Promise<void> => {
    const bundle = pending.get(key);
    if (!bundle) return;
    // Remove BEFORE flushing: arrivals during the flush open the
    // next bundle instead of joining a turn already being worked.
    pending.delete(key);
    try {
      await bundle.flush(bundle.items);
    } catch (err) {
      if (bundle.onError) {
        try {
          await bundle.onError(bundle.items, err);
        } catch (handlerErr) {
          console.error("[telegram] burst error handler failed", handlerErr);
        }
      } else {
        console.error("[telegram] burst flush failed", err);
      }
    }
  };

  return {
    enqueue(key, item, flush, onError) {
      const existing = pending.get(key);
      if (!existing) {
        const bundle: PendingBundle = {
          items: [item],
          flush,
          onError,
          startedAt: now(),
          collecting: item.isForwarded,
          timer: null,
        };
        pending.set(key, bundle);
        schedule(key, bundle, item.isForwarded ? quietMs : detectionGraceMs);
        return 1;
      }
      // Defense in depth under the update_id claim: a redelivery
      // that somehow reaches the collector twice joins once.
      if (
        item.updateId !== undefined &&
        existing.items.some((i) => i.updateId === item.updateId)
      ) {
        return existing.items.length;
      }
      existing.items.push(item);
      // The latest caller's handlers win - every caller for one
      // chat carries the same deps, and the error handler works
      // off the item list it is handed, not a captured item.
      existing.flush = flush;
      existing.onError = onError;
      existing.collecting = true;
      const elapsed = now() - existing.startedAt;
      const delay =
        existing.items.length >= maxItems
          ? 0
          : Math.max(0, Math.min(quietMs, maxWaitMs - elapsed));
      schedule(key, existing, delay);
      return existing.items.length;
    },
    hasPending(key) {
      return pending.has(key);
    },
  };
}
