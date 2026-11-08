import { describe, expect, it } from "vitest";
import { feedStatus, FEED_OFF_TEXT, FEED_SETUP_TEXT, FEED_STALE_TEXT } from "@/lib/feed-status";
import { cleanResearchError } from "@/lib/research-errors";

const watcher = (key: string, last_error: string | null = null, last_status = "ok") => ({ watcher_key: key, last_error, last_status, last_polled_at: null });
const page = (over: Record<string, unknown> = {}) => ({ engine_enabled: true, runner: { last_tick_at: "2026-11-07T10:00:00Z", last_source: "x", stale: false }, watchers: [watcher("eia_diesel")], ...over }) as never;

describe("feedStatus: one verdict for Home and Industry Intelligence", () => {
  it("off / setup / stale / degraded / ok, each with its one sentence", () => {
    expect(feedStatus(page({ engine_enabled: false }))).toMatchObject({ state: "off", text: FEED_OFF_TEXT });
    expect(feedStatus(page({ runner: null }))).toMatchObject({ state: "setup", text: FEED_SETUP_TEXT });
    expect(feedStatus(page({ runner: { last_tick_at: "x", last_source: null, stale: true } }))).toMatchObject({ state: "stale", text: FEED_STALE_TEXT });
    const d = feedStatus(page({ watchers: [watcher("eia_diesel"), watcher("industry_news", "HTTP 403")] }));
    expect(d.state).toBe("degraded");
    expect(d.failing).toEqual(["industry news"]);
    expect(feedStatus(page()).state).toBe("ok");
  });
  it("an unavailable status is stated, not assumed healthy", () => {
    expect(feedStatus(null).text).toContain("unavailable");
  });
});

describe("cleanResearchError: no raw provider text on the Research tab", () => {
  it("maps known failures to plain sentences", () => {
    expect(cleanResearchError("FMCSA Newsroom answered HTTP 403 Forbidden")).toMatch(/refused our request/);
    expect(cleanResearchError("getaddrinfo ENOTFOUND api.example.com")).toMatch(/network/);
    expect(cleanResearchError("429 Too Many Requests")).toMatch(/slow down/);
    expect(cleanResearchError("Unexpected token < in JSON at position 0")).toMatch(/format/);
  });
  it("strips URLs, JSON and stack frames from anything unknown, and caps it", () => {
    const out = cleanResearchError('Weird thing at https://x.test/a?b=1 {"a":1} at foo (/srv/app/file.js:1:2) happened');
    expect(out).not.toMatch(/https?:|\{|file\.js/);
    expect(cleanResearchError("x".repeat(500)).length).toBeLessThanOrEqual(141);
    expect(cleanResearchError("")).toBe("");
  });
});
