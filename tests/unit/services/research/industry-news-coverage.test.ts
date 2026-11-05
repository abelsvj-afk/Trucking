// The partial-coverage message must carry each failed feed's CAUSE (the HTTP
// status captured by the feed fetch) so one production poll shows why the FMCSA
// feed fails - the owner's drop decision rests on that evidence.
import { describe, expect, it, vi } from "vitest";

const feeds = vi.hoisted(() => ({ value: [] as Array<{ source: string; items: unknown[]; error: string | null }> }));
vi.mock("@/services/integrations/rss", () => ({ fetchIndustryNews: async () => feeds.value }));

import { industryNewsWatcher } from "@/services/research/watchers/industry-news";

describe("industry news partial coverage", () => {
  it("names the failed source AND its cause", async () => {
    feeds.value = [
      { source: "FMCSA Newsroom", items: [], error: "FMCSA Newsroom answered HTTP 403 Forbidden" },
      { source: "FreightWaves", items: [], error: null },
      { source: "Overdrive", items: [], error: null },
    ];
    const r = await industryNewsWatcher.poll({});
    expect(r.status).toBe("ok");
    expect(r.message).toContain("FMCSA Newsroom (FMCSA Newsroom answered HTTP 403 Forbidden)");
    expect(r.message).toMatch(/failed this poll/);
  });
  it("no failures: no message", async () => {
    feeds.value = [{ source: "FMCSA Newsroom", items: [], error: null }];
    expect((await industryNewsWatcher.poll({})).message).toBeNull();
  });
});
