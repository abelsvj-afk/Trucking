// OpenStates watcher tests - mocked HTTP only.
//
// Pins the watcher's `updated_since` format: a plain YYYY-MM-DD date.
// The API documents the parameter as "a given date"; the watcher used
// to send a full ISO timestamp with milliseconds, which is the prime
// suspect for the production 400s (see integrations/openstates.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATED_WINDOW_DAYS, openStatesWatcher } from "@/services/research/watchers/openstates";

const originalFetch = global.fetch;
const originalKey = process.env.OPENSTATES_API_KEY;

beforeEach(() => {
  process.env.OPENSTATES_API_KEY = "test-key";
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env.OPENSTATES_API_KEY = originalKey;
  vi.restoreAllMocks();
});

describe("openStatesWatcher poll", () => {
  it("sends updated_since as a plain date (YYYY-MM-DD), not a full timestamp", async () => {
    const seenSince: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      seenSince.push(new URL(String(input)).searchParams.get("updated_since") ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      };
    }) as never;

    const result = await openStatesWatcher.poll({ rotation: 0 });

    expect(result.status).toBe("ok");
    expect(seenSince.length).toBeGreaterThan(0);
    for (const since of seenSince) {
      expect(since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("looks back 14 days and the poll message says how many bills it saw versus kept", async () => {
    const seen: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      seen.push(new URL(String(input)).searchParams.get("updated_since") ?? "");
      return { ok: true, status: 200, json: async () => ({ results: [{ id: "ocd-bill/1", title: "Study of school bus routes" }] }) };
    }) as never;
    const result = await openStatesWatcher.poll({ rotation: 0 });
    const expected = new Date(Date.now() - UPDATED_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    expect(UPDATED_WINDOW_DAYS).toBe(14);
    expect(seen.every((d) => d === expected)).toBe(true);
    expect(result.signals).toHaveLength(0);
    expect(result.message).toContain('3 bill(s) matched "truck"');
    expect(result.message).toContain("0 fit a tracked category");
  });

  it("skips visibly when the key is not set", async () => {
    delete process.env.OPENSTATES_API_KEY;
    const result = await openStatesWatcher.poll({});
    expect(result.status).toBe("skipped");
    expect(result.message).toContain("OPENSTATES_API_KEY is not set");
  });
});
