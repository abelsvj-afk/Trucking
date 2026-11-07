import { describe, expect, it } from "vitest";

// Exact connection errors (owner 2026-11-07: "show the exact error from the server instead of just can't reach
// server"). native/tracker/www/feed-queue.js, plain JS tested here.
// @ts-expect-error -- plain JS module (native/tracker/www) with no declaration file
const load = async () => (await import("../../../native/tracker/www/feed-queue.js")) as unknown as {
  flush: (a: { queue: { at: number }[]; serverUrl: string; key: string; failures: number; fetchFn: (...a: unknown[]) => Promise<unknown> }) => Promise<{ queue: unknown[]; outcome: string; failures: number; detail: string | null }>;
  describeNetworkError: (e: unknown, url: string) => string;
  describeResponse: (r: unknown) => Promise<string>;
  scrubKey: (t: string, key: string) => string;
};

const KEY = "tdv_abcdefghijklmnopqrstuvwxyz0123456789";
const queue = [{ at: 1 }, { at: 2 }];
const reply = (status: number, body: string, headers: Record<string, string> = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => body,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
});
const run = async (fetchFn: (...a: unknown[]) => Promise<unknown>, failures = 0) => {
  const q = await load();
  return q.flush({ queue, serverUrl: "https://trucking.fly.dev/", key: KEY, failures, fetchFn });
};

describe("flush reports the exact reason", () => {
  it("success has no error detail", async () => {
    expect((await run(async () => reply(200, '{"data":{"accepted":2}}', { "content-type": "application/json" }))).detail).toBeNull();
  });
  it("shows the server's own error code and message for an HTTP failure", async () => {
    const r = await run(async () => reply(503, '{"error":{"code":"UNAVAILABLE","message":"Position feed is not configured."}}'));
    expect(r.outcome).toBe("retry");
    expect(r.detail).toBe("Server answered HTTP 503 - UNAVAILABLE: Position feed is not configured.");
    expect(r.queue).toHaveLength(2);
  });
  it("a 401 names the server's answer and still keeps the data", async () => {
    const r = await run(async () => reply(401, '{"error":{"code":"UNAUTHORIZED","message":"Unauthorized."}}'));
    expect(r.outcome).toBe("unauthorized");
    expect(r.detail).toBe("Server answered HTTP 401 - UNAUTHORIZED: Unauthorized.");
    expect(r.queue).toHaveLength(2);
  });
  it("a 400 says what the server rejected and that the batch was dropped", async () => {
    const r = await run(async () => reply(400, '{"error":{"code":"VALIDATION_ERROR","message":"Body must be { fixes: [...] }."}}'), 3);
    expect(r.outcome).toBe("sent");
    expect(r.detail).toMatch(/HTTP 400 - VALIDATION_ERROR: Body must be/);
    expect(r.detail).toMatch(/dropped 2 fix/);
  });
  it("a non-JSON answer is shown as plain text, trimmed", async () => {
    const r = await run(async () => reply(502, "<html>  Bad   Gateway </html>"));
    expect(r.detail).toBe("Server answered HTTP 502 - <html> Bad Gateway </html>");
  });
  it("an answer with no body says so instead of guessing", async () => {
    expect((await run(async () => reply(500, ""))).detail).toBe("Server answered HTTP 500 (no message)");
  });
  it("a network failure names the host, the error type and the real message", async () => {
    const r = await run(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(r.outcome).toBe("retry");
    expect(r.failures).toBe(1);
    expect(r.detail).toContain("trucking.fly.dev");
    expect(r.detail).toContain("TypeError: Failed to fetch");
  });
  it("a 200 that is a web page (login redirect / wrong address) is a failure, not success", async () => {
    const r = await run(async () => reply(200, "<html>login</html>", { "content-type": "text/html; charset=utf-8" }));
    expect(r.outcome).toBe("retry");
    expect(r.queue).toHaveLength(2);
    expect(r.detail).toMatch(/web page, not the position feed - check the server URL/);
  });
  it("sends to the address it was given, with the key it was given", async () => {
    const seen: { url: string; auth: string }[] = [];
    await run(async (...a: unknown[]) => {
      const [url, init] = a as [string, { headers: { Authorization: string } }];
      seen.push({ url, auth: init.headers.Authorization });
      return reply(200, "{}", { "content-type": "application/json" });
    });
    expect(seen).toEqual([{ url: "https://trucking.fly.dev/api/v1/position/feed", auth: "Bearer " + KEY }]);
  });
});

describe("the key never reaches the log or the screen", () => {
  it("scrubKey removes the exact key and anything shaped like one", async () => {
    const { scrubKey } = await load();
    expect(scrubKey(`bad ${KEY} and tdv_zzzzzzzzzzzzzzzzzz1`, KEY)).toBe("bad tdv_[hidden] and tdv_[hidden]");
    expect(scrubKey("nothing secret", KEY)).toBe("nothing secret");
  });
});
