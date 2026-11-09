// Learning agenda pass (docs/design/autonomous-research.md §4)
// against a fake Queryable: gaps become PROPOSED rows (never queued
// runs), open proposals dedupe, the per-tick cap holds, a pre-00084
// database skips quietly, and the runner settle hook closes a queued
// topic when its run finishes.

import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/services/ai/run-industry-briefing";
import { runLearningAgendaPass, settleLearningTopicForRun } from "@/services/research/learning-agenda";

const COMPANY = "company-1";
const NOW = new Date("2026-11-09T17:00:00Z");

interface FakeOptions {
  latest?: Array<Record<string, unknown>>;
  open?: Array<Record<string, unknown>>;
  missingTable?: boolean;
}

function fakeDb(options: FakeOptions = {}) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    if (options.missingTable && (text.includes("research_knowledge") || text.includes("research_learning_topics"))) {
      throw new Error('relation "research_learning_topics" does not exist');
    }
    if (text.includes("distinct on (watch_topic)")) return { rows: options.latest ?? [] };
    if (text.includes("from research_learning_topics") && text.includes("status in ('proposed', 'queued')")) {
      return { rows: options.open ?? [] };
    }
    if (text.includes("insert into research_learning_topics")) return { rows: [{ id: "t-1" }] };
    return { rows: [] };
  });
  return { db: { query } as unknown as Queryable, calls };
}

describe("runLearningAgendaPass", () => {
  it("files baseline proposals when nothing is stored, capped per tick", async () => {
    const { db, calls } = fakeDb();
    const filed = await runLearningAgendaPass(db, COMPANY, 2, NOW);
    expect(filed).toBe(2);
    const inserts = calls.filter((c) => c.text.includes("insert into research_learning_topics"));
    expect(inserts).toHaveLength(2);
    for (const insert of inserts) {
      expect(insert.params?.[0]).toBe(COMPANY);
      expect(insert.text).toContain("'proposed'");
      expect(insert.text).not.toContain("research_runs");
    }
  });

  it("files nothing when an open proposal already covers the gap topics", async () => {
    const { db } = fakeDb({
      open: [
        { id: "t-1", watch_topic: "authority_pathways", status: "proposed" },
        { id: "t-2", watch_topic: "build_plan", status: "proposed" },
        { id: "t-3", watch_topic: "industry", status: "queued" },
      ],
    });
    await expect(runLearningAgendaPass(db, COMPANY, 2, NOW)).resolves.toBe(0);
  });

  it("skips quietly before migration 00084 lands", async () => {
    const { db } = fakeDb({ missingTable: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runLearningAgendaPass(db, COMPANY, 2, NOW)).resolves.toBe(0);
    spy.mockRestore();
  });

  it("files nothing when knowledge is fresh everywhere it matters", async () => {
    const fresh = (watch_topic: string) => ({
      watch_topic,
      title: "t",
      content: "c",
      source_title: null,
      source_url: null,
      observed_at: "2026-11-09T12:00:00Z",
    });
    const { db } = fakeDb({
      latest: [fresh("own_business"), fresh("industry"), fresh("crypto"), fresh("authority_pathways"), fresh("build_plan")],
    });
    await expect(runLearningAgendaPass(db, COMPANY, 2, NOW)).resolves.toBe(0);
  });
});

describe("settleLearningTopicForRun", () => {
  it("closes only the queued topic tied to the finished run", async () => {
    const { db, calls } = fakeDb();
    await settleLearningTopicForRun(db, "run-9");
    const update = calls.find((c) => c.text.includes("update research_learning_topics"));
    expect(update).toBeDefined();
    expect(update!.params).toEqual(["run-9"]);
    expect(update!.text).toContain("status = 'queued'");
  });
});
