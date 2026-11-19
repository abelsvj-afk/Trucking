// Browser runtime client seam: not-configured vs shared-vm, live
// watch links, and stopping a run. No test here touches the network:
// the configured runtime is driven by local fetch doubles.
import { describe, expect, it } from "vitest";
import {
  createBrowserRuntime,
  HUMAN_PACE,
  SCOUT_SCAN_DEFAULTS,
  STOP_RUN_TIMEOUT_MS,
} from "@/services/bots/browser-runtime";

const CONFIGURED_ENV = {
  BOT_BROWSER_URL: "https://browser.example.com",
  BOT_BROWSER_SHARED_SECRET: "test-secret",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("human pace and scan defaults", () => {
  it("paces reads at least 20 seconds apart, at most 3 boards per run, 60 second timeout", () => {
    expect(HUMAN_PACE.minGapMsBetweenReads).toBe(20000);
    expect(HUMAN_PACE.maxBoardsPerRun).toBe(3);
    expect(HUMAN_PACE.readTimeoutMs).toBe(60000);
  });

  it("scans every 30 minutes by day (6 AM–9 PM ET) and hourly overnight, quiet hours 9 PM–6 AM ET", () => {
    expect(SCOUT_SCAN_DEFAULTS.dayStartHourEt).toBe(6);
    expect(SCOUT_SCAN_DEFAULTS.dayEndHourEt).toBe(21);
    expect(SCOUT_SCAN_DEFAULTS.dayIntervalMinutes).toBe(30);
    expect(SCOUT_SCAN_DEFAULTS.nightIntervalMinutes).toBe(60);
    expect(SCOUT_SCAN_DEFAULTS.quietHoursStartEt).toBe(21);
    expect(SCOUT_SCAN_DEFAULTS.quietHoursEndEt).toBe(6);
  });

  it("heartbeats every 5 minutes and flags the Scout down after 15 minutes of silence", () => {
    expect(SCOUT_SCAN_DEFAULTS.heartbeatIntervalMinutes).toBe(5);
    expect(SCOUT_SCAN_DEFAULTS.heartbeatMissedMinutes).toBe(15);
  });

  it("gives a stop call 15 seconds", () => {
    expect(STOP_RUN_TIMEOUT_MS).toBe(15000);
  });
});

describe("browser runtime, not configured", () => {
  it("reads nothing and says so plainly, without throwing", async () => {
    const runtime = createBrowserRuntime({});
    expect(runtime.route).toBe("not-configured");
    const result = await runtime.readBoard("trulos", "https://trulos.com/load-board");
    expect(result.status).toBe("not-configured");
    expect(result.loads).toEqual([]);
    expect(result.note).toMatch(/not configured on the server yet/);
  });

  it("watchUrl returns null when not configured — there is nothing to watch", () => {
    const runtime = createBrowserRuntime({});
    expect(runtime.watchUrl("run_abc123")).toBeNull();
  });

  it("stopRun returns stopped=false with a plain-words reason, and never throws", async () => {
    const runtime = createBrowserRuntime({});
    const result = await runtime.stopRun("run_abc123");
    expect(result.stopped).toBe(false);
    expect(result.reason).toMatch(/not configured/);
  });
});

describe("browser runtime, configured", () => {
  it("maps a failed fetch to status error and never throws", async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error("network down");
    };
    const runtime = createBrowserRuntime(CONFIGURED_ENV, failingFetch);
    expect(runtime.route).toBe("shared-vm");
    const result = await runtime.readBoard("trulos", "https://trulos.com/load-board");
    expect(result.status).toBe("error");
    expect(result.loads).toEqual([]);
    expect(result.note).toMatch(/network down/);
  });

  it("passes a good worker answer through, with the worker's own status and rows", async () => {
    const okFetch: typeof fetch = async () =>
      jsonResponse({
        boardSlug: "trulos",
        status: "ok",
        loads: [{ origin: "Atlanta, GA", destination: "Dallas, TX", rate: "$1,850" }],
        note: "Read fine.",
      });
    const runtime = createBrowserRuntime(CONFIGURED_ENV, okFetch);
    const result = await runtime.readBoard("trulos", "https://trulos.com/load-board");
    expect(result.status).toBe("ok");
    expect(result.loads).toHaveLength(1);
    expect(result.note).toBe("Read fine.");
  });

  it("maps a non-200 worker answer to status error", async () => {
    const badFetch: typeof fetch = async () => jsonResponse({ error: "boom" }, 500);
    const runtime = createBrowserRuntime(CONFIGURED_ENV, badFetch);
    const result = await runtime.readBoard("trulos", "https://trulos.com/load-board");
    expect(result.status).toBe("error");
    expect(result.note).toMatch(/500/);
  });

  it("watchUrl builds the watch link for a run, and null for a blank run id", () => {
    const runtime = createBrowserRuntime(CONFIGURED_ENV);
    expect(runtime.watchUrl("run_abc123")).toBe("https://browser.example.com/watch/run_abc123");
    expect(runtime.watchUrl("   ")).toBeNull();
  });

  it("stopRun returns stopped=true when the worker confirms the stop", async () => {
    const stopFetch: typeof fetch = async () => jsonResponse({ stopped: true, note: "Run stopped." });
    const runtime = createBrowserRuntime(CONFIGURED_ENV, stopFetch);
    const result = await runtime.stopRun("run_abc123");
    expect(result.stopped).toBe(true);
    expect(result.reason).toMatch(/stopped/);
  });

  it("stopRun returns stopped=false, never throws, when the worker or the network fails", async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error("network down");
    };
    const runtime = createBrowserRuntime(CONFIGURED_ENV, failingFetch);
    const failed = await runtime.stopRun("run_abc123");
    expect(failed.stopped).toBe(false);
    expect(failed.reason).toMatch(/network down/);

    const badFetch: typeof fetch = async () => jsonResponse({ stopped: false, note: "No such run." });
    const runtime2 = createBrowserRuntime(CONFIGURED_ENV, badFetch);
    const noRun = await runtime2.stopRun("run_abc123");
    expect(noRun.stopped).toBe(false);
    expect(noRun.reason).toMatch(/No such run/);
  });
});
