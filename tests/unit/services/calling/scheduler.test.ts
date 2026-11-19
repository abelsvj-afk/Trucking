// Audit A-M5 / A-m8: the call-queue sweep - a missed/lost Telnyx
// terminal event must not stall every later queued call, and a
// missing piece of calling setup must be named, not swallowed.
// No live Telnyx, no live database: the client is a hand-rolled
// chainable fake, the fetch is never reached in these paths.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dialNextQueued } from "@/services/calling/dial-next";
import { reapStaleOutboundClaims, staleClaimOutcome } from "@/services/calling/queue";
import { runCallingSweep } from "@/services/calling/scheduler";

const NOW = Date.parse("2026-11-18T15:00:00Z");
const MIN = 60_000;

const FULL_ENV = {
  TELNYX_API_KEY: "test-key",
  TELNYX_PHONE_NUMBER: "+15551234567",
  TELNYX_CONNECTION_ID: "conn-1",
  TELNYX_ASSISTANT_ID: "asst-1",
  TELNYX_PUBLIC_KEY: "test-public-key",
};

let savedEnv: Record<string, string | undefined> = {};
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  savedEnv = {};
  for (const key of Object.keys(FULL_ENV)) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  errorSpy.mockRestore();
});

function setFullEnv() {
  for (const [key, value] of Object.entries(FULL_ENV)) process.env[key] = value;
}

/** Chainable fake covering exactly the query shapes queue.ts uses. */
function fakeOutboundClient(rows: { id: string; status: string; updated_at: string }[]) {
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  let op: "select" | "update" = "select";
  let patch: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {};
  builder.select = () => {
    op = "select";
    return builder;
  };
  builder.update = (p: Record<string, unknown>) => {
    op = "update";
    patch = p;
    return builder;
  };
  builder.eq = (col: string, value: unknown) => {
    if (op === "update" && col === "id") updates.push({ id: String(value), patch });
    return builder;
  };
  builder.in = () => builder;
  builder.is = () => builder;
  builder.then = (resolve: (v: unknown) => void) =>
    resolve(op === "select" ? { data: rows, error: null } : { data: null, error: null });
  return {
    client: { from: () => builder } as unknown as SupabaseClient,
    updates,
  };
}

describe("staleClaimOutcome", () => {
  it("a dialing claim older than 10 minutes is stale; a fresh one is not", () => {
    expect(staleClaimOutcome("dialing", NOW - 11 * MIN, NOW)).toMatch(/stalled while dialing/);
    expect(staleClaimOutcome("dialing", NOW - 5 * MIN, NOW)).toBeNull();
  });
  it("an in-progress call older than 4 hours is stale; a 1-hour call is not", () => {
    expect(staleClaimOutcome("in_progress", NOW - 5 * 60 * MIN, NOW)).toMatch(/without a closing update/);
    expect(staleClaimOutcome("in_progress", NOW - 60 * MIN, NOW)).toBeNull();
  });
  it("a completed row is never a stale claim", () => {
    expect(staleClaimOutcome("completed", NOW - 24 * 60 * MIN, NOW)).toBeNull();
  });
});

describe("reapStaleOutboundClaims", () => {
  it("fails only the stale claimed rows, with a plain-words outcome, and frees the queue", async () => {
    const { client, updates } = fakeOutboundClient([
      { id: "old-dial", status: "dialing", updated_at: new Date(NOW - 30 * MIN).toISOString() },
      { id: "fresh-dial", status: "dialing", updated_at: new Date(NOW - 2 * MIN).toISOString() },
      { id: "old-live", status: "in_progress", updated_at: new Date(NOW - 5 * 60 * MIN).toISOString() },
    ]);
    const reaped = await reapStaleOutboundClaims(client, "company-1", NOW);
    expect(reaped).toBe(2);
    expect(updates.map((u) => u.id).sort()).toEqual(["old-dial", "old-live"]);
    for (const u of updates) {
      expect(u.patch.status).toBe("failed");
      expect(typeof u.patch.outcome).toBe("string");
    }
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("reaped stale dialing call old-dial"));
  });
});

describe("dialNextQueued", () => {
  it("names the missing piece of calling setup instead of returning silently (A-m8)", async () => {
    const { client } = fakeOutboundClient([]);
    await dialNextQueued(client, "company-1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Telnyx API key isn't set"));
  });

  it("a claim failure is logged, not swallowed, and the queue is left alone", async () => {
    setFullEnv();
    const client = {
      rpc: async () => {
        throw new Error("db down");
      },
    } as unknown as SupabaseClient;
    await dialNextQueued(client, "company-1");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("claiming the next queued call failed"),
      expect.any(Error),
    );
  });

  it("nothing queued means nothing dialed and nothing logged", async () => {
    setFullEnv();
    const client = {
      rpc: async () => ({ data: null, error: null }),
    } as unknown as SupabaseClient;
    await dialNextQueued(client, "company-1");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("runCallingSweep", () => {
  it("reaps, dials, and fires the feed-stale tell in one tick", async () => {
    const { client } = fakeOutboundClient([]);
    const reapStale = vi.fn().mockResolvedValue(1);
    const dialNext = vi.fn().mockResolvedValue(undefined);
    const sendFeedStaleTell = vi.fn().mockResolvedValue(false);
    await runCallingSweep({
      serviceClient: () => client,
      companyId: () => "company-1",
      reapStale,
      dialNext,
      sendFeedStaleTell,
      nowMs: NOW,
    });
    expect(reapStale).toHaveBeenCalledWith(client, "company-1", NOW);
    expect(dialNext).toHaveBeenCalledWith(client, "company-1");
    expect(sendFeedStaleTell).toHaveBeenCalledWith(
      expect.objectContaining({ client, companyId: "company-1", nowMs: NOW }),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("reaped 1 stale"));
  });

  it("does nothing when the bot company is not configured", async () => {
    const dialNext = vi.fn();
    const sendFeedStaleTell = vi.fn();
    await runCallingSweep({
      serviceClient: () => null,
      companyId: () => null,
      dialNext,
      sendFeedStaleTell,
    });
    expect(dialNext).not.toHaveBeenCalled();
    expect(sendFeedStaleTell).not.toHaveBeenCalled();
  });

  it("never throws: a failed reap logs and the sweep returns", async () => {
    const { client } = fakeOutboundClient([]);
    await expect(
      runCallingSweep({
        serviceClient: () => client,
        companyId: () => "company-1",
        reapStale: async () => {
          throw new Error("db down");
        },
        dialNext: vi.fn(),
        sendFeedStaleTell: vi.fn(),
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("sweep failed"), expect.any(Error));
  });
});
