// Browser runtime client seam (Dispatch Scout board reading).
// The main app never drives a browser itself. It talks to one small,
// always-on browser VM ("trucking-browser", see
// docs/bot-team-browser-runtime.md) over HTTP: POST {board, url} to
// /read, with a shared-secret header. The VM owns the real browser
// session and the logged-in profile; this module owns only the call.
//
// LIVE WATCH: the owner can watch that same browser session live
// from his phone — the VM runs the real browser under Xvfb and
// serves it via noVNC (see the design doc) — and can stop the run
// or take the browser over from the watch page. watchUrl() builds
// the watch link for a run; stopRun() kills a run through the VM
// API. Neither ever throws for a missing or failed VM.
//
// Limits, stated plainly:
// - The browser VM does not exist yet, so the shared-vm path has never
//   been proven against a real worker. Until it exists, every read
//   returns "not-configured" and no board is read.
// - A failed read never throws. The walker (services/bots/boards.ts)
//   falls through to the next board on any failure, and the failure is
//   reported in plain words — never silently dropped, never faked.
// - No credentials live in this file. The URL and secret come from
//   Fly secrets (BOT_BROWSER_URL, BOT_BROWSER_SHARED_SECRET) only.

export type BoardReadStatus = "ok" | "blocked-cloudflare" | "blocked-login" | "empty" | "not-configured" | "error";

export interface BoardReadResult {
  boardSlug: string;
  status: BoardReadStatus;
  /** Raw rows, exactly as the browser worker returned them. boards.ts normalizes them. */
  loads: unknown[];
  note: string;
  readAtIso: string;
}

/**
 * Human pace, enforced by the caller between reads — the browser VM
 * is a guest on the boards, not a scraper. At most 3 boards per run
 * (the whole free list), at least 20 seconds between reads, and a
 * read that takes longer than 60 seconds is abandoned, not retried
 * blindly.
 */
export const HUMAN_PACE = { minGapMsBetweenReads: 20000, maxBoardsPerRun: 3, readTimeoutMs: 60000 } as const;

/**
 * The always-on scan defaults (design doc, "24/7 always-on"). The
 * scan scheduler lives on the browser VM; these are the numbers it
 * runs on unless the owner changes them. All hours are Eastern
 * (America/New_York), the owner's timezone — never UTC.
 * Day is 6 AM–9 PM ET; night is hourly; quiet hours (9 PM–6 AM ET)
 * hold anything the owner would SEE until morning unless it is
 * time-sensitive. The heartbeat is the VM proving it is alive.
 */
export const SCOUT_SCAN_DEFAULTS = {
  dayStartHourEt: 6,
  dayEndHourEt: 21,
  dayIntervalMinutes: 30,
  nightIntervalMinutes: 60,
  quietHoursStartEt: 21,
  quietHoursEndEt: 6,
  heartbeatIntervalMinutes: 5,
  heartbeatMissedMinutes: 15,
} as const;

/** A stop is a quick control call, not a board read — 15 seconds is enough. */
export const STOP_RUN_TIMEOUT_MS = 15000;

export interface BrowserRuntime {
  readonly route: "shared-vm" | "not-configured";
  readBoard(boardSlug: string, url: string, runId?: string): Promise<BoardReadResult>;
  /**
   * The URL the owner opens on his phone to watch this run's live
   * browser. Null when the runtime is not configured (or the run id
   * is blank) — there is nothing to watch.
   */
  watchUrl(runId: string): string | null;
  /**
   * Stop a run on the VM. Never throws: when there is nothing to
   * stop, or the runtime is not configured, it returns
   * stopped=false with a plain-words reason.
   */
  stopRun(runId: string): Promise<{ stopped: boolean; reason: string }>;
}

export const NOT_CONFIGURED_NOTE = "The shared browser is not configured on the server yet — no board was read.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoardReadStatus(value: unknown): value is BoardReadStatus {
  return (
    value === "ok" ||
    value === "blocked-cloudflare" ||
    value === "blocked-login" ||
    value === "empty" ||
    value === "not-configured" ||
    value === "error"
  );
}

function readResult(boardSlug: string, status: BoardReadStatus, loads: unknown[], note: string): BoardReadResult {
  return { boardSlug, status, loads, note, readAtIso: new Date().toISOString() };
}

/**
 * Build the runtime from env. Both BOT_BROWSER_URL and
 * BOT_BROWSER_SHARED_SECRET must be set for the shared-vm route;
 * either one missing means "not-configured" and no board is read.
 *
 * `fetchImpl` exists only so tests can pass a local double — it is
 * never a second way to reach a board in production.
 */
export function createBrowserRuntime(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): BrowserRuntime {
  const baseUrl = env.BOT_BROWSER_URL;
  const sharedSecret = env.BOT_BROWSER_SHARED_SECRET;
  if (!baseUrl || !sharedSecret) {
    return {
      route: "not-configured",
      readBoard: async (boardSlug: string): Promise<BoardReadResult> =>
        readResult(boardSlug, "not-configured", [], NOT_CONFIGURED_NOTE),
      watchUrl: (): string | null => null,
      stopRun: async (): Promise<{ stopped: boolean; reason: string }> => ({
        stopped: false,
        reason: "The shared browser is not configured on the server yet — there is no run to stop.",
      }),
    };
  }

  const base = baseUrl.replace(/\/+$/, "");
  const endpoint = `${base}/read`;
  const stopEndpoint = `${base}/stop`;
  return {
    route: "shared-vm",
    readBoard: async (boardSlug: string, url: string, runId?: string): Promise<BoardReadResult> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HUMAN_PACE.readTimeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bot-browser-secret": sharedSecret,
          },
          body: JSON.stringify(
            runId ? { board: boardSlug, url, runId } : { board: boardSlug, url },
          ),
          signal: controller.signal,
        });
        if (!response.ok) {
          return readResult(
            boardSlug,
            "error",
            [],
            `The browser worker answered ${response.status} for ${boardSlug} — no loads were read. The next board will be tried.`,
          );
        }
        const body: unknown = await response.json();
        if (!isRecord(body)) {
          return readResult(boardSlug, "error", [], `The browser worker answered ${boardSlug} in a shape this app cannot read — no loads were read.`);
        }
        const status = isBoardReadStatus(body.status) ? body.status : "error";
        const loads = Array.isArray(body.loads) ? body.loads : [];
        const note = typeof body.note === "string" && body.note.length > 0 ? body.note : "The browser worker gave no note for this read.";
        return readResult(boardSlug, status, loads, note);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const timedOut = error instanceof Error && error.name === "AbortError";
        return readResult(
          boardSlug,
          "error",
          [],
          timedOut
            ? `Reading ${boardSlug} took longer than ${HUMAN_PACE.readTimeoutMs / 1000} seconds, so the read was abandoned — no loads were read.`
            : `Reading ${boardSlug} failed (${reason}) — no loads were read. The next board will be tried.`,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
    watchUrl: (runId: string): string | null => {
      if (runId.trim().length === 0) return null;
      return `${base}/watch/${encodeURIComponent(runId)}`;
    },
    stopRun: async (runId: string): Promise<{ stopped: boolean; reason: string }> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), STOP_RUN_TIMEOUT_MS);
      try {
        const response = await fetchImpl(stopEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bot-browser-secret": sharedSecret,
          },
          body: JSON.stringify({ runId }),
          signal: controller.signal,
        });
        if (!response.ok) {
          return {
            stopped: false,
            reason: `The browser worker answered ${response.status} to the stop request — the run may still be going. Try again, or check the watch page.`,
          };
        }
        const body: unknown = await response.json();
        if (isRecord(body) && body.stopped === true) {
          return { stopped: true, reason: "The run was stopped. The browser is parked — nothing more will be read until the next scheduled scan." };
        }
        const note =
          isRecord(body) && typeof body.note === "string" && body.note.length > 0
            ? body.note
            : "The browser worker did not confirm the run stopped — it may already have finished, or the stop did not land.";
        return { stopped: false, reason: note };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const timedOut = error instanceof Error && error.name === "AbortError";
        return {
          stopped: false,
          reason: timedOut
            ? "The stop request took longer than 15 seconds, so it was abandoned — the run may still be going. Check the watch page."
            : `The stop request failed (${reason}) — the run may still be going. Check the watch page.`,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
