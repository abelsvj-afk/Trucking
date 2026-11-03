// Phase F — Abel memory evaluation harness (fixture arm).
//
// Design: Trucking-Abel-Intelligence-Upgrade-Design-2026-11-02.md
// Phase F + §8.1. The harness drives the PRODUCTION Phase A+B code
// (retrieveCurrentFacts / searchMemoryEverywhere / createBotStore /
// runConsolidation) against seeded fixture stores and scores the
// five LongMemEval abilities. Targets from the design:
//   recall@retrieved >= 90%   abstention >= 95%
// Harness policy on top: knowledge updates and contradiction
// surfacing are correctness, not rates — a stale fact served as
// current is the design's named worst failure — so those gate at
// 100%.
//
// Two arms per case: "hybrid" (the 00029 RPC contract is live in
// the fake, semantic arm fed by the fixture concept embedder) and
// "fallback" (every RPC errors — the pre-migration database — so
// production code takes its keyword arms). What this arm proves:
// the retrieval/lifecycle CODE honors its contracts — current-only
// filtering, RRF fusion, budgets, supersession, staged-not-applied
// contradictions — with no silent loss at the old cliffs. What it
// cannot prove: the real embedding model's semantic quality and
// the model's own abstention wording. Those are the live arm
// (live-eval.test.ts, self-skipping) — see tests/eval/README.md.

// The store's write path embeds best-effort via the process-wide
// provider; the gate must never reach the real API.
process.env.OPENAI_API_KEY = "";

import { describe, expect, it } from "vitest";
import { retrieveCurrentFacts, searchMemoryEverywhere } from "@/services/bot/memory-retrieval";
import { createBotStore } from "@/services/bot/store";
import { runConsolidation } from "@/services/bot/consolidation";
import type { BotMemoryRow } from "@/services/telegram/context";
import { createEvalClient, type EvalDb } from "./fixtures/fake-supabase";
import { conceptEmbedder } from "./fixtures/concept-embedder";
import {
  ABSTENTION_CASES,
  COMPANY_ID,
  RECALL_CASES,
  STORE_A,
  UPDATE_CASES,
  type AbstentionCase,
  type FixtureMemory,
  type FixtureMessage,
  type RecallCase,
  type UpdateCase,
} from "./fixtures/golden-set";

interface Outcome {
  id: string;
  group: string;
  pass: boolean;
  detail?: string;
}
const outcomes: Outcome[] = [];
const record = (group: string, id: string, pass: boolean, detail?: string) => {
  outcomes.push({ group, id, pass, detail });
};

function dbFrom(memories: FixtureMemory[], messages: FixtureMessage[] = []): EvalDb {
  return {
    bot_memories: memories.map((m) => ({
      company_id: COMPANY_ID,
      deleted_at: null,
      valid_to: null,
      superseded_by: null,
      ...m,
    })),
    telegram_messages: messages.map((m) => ({
      company_id: COMPANY_ID,
      deleted_at: null,
      ...m,
    })),
    documents: [],
    bot_pending_actions: [],
    conversation_summaries: [],
    consolidation_runs: [],
  };
}

const embedderFor = (arm: "hybrid" | "fallback") => (arm === "hybrid" ? conceptEmbedder : null);
const rpcModeFor = (arm: "hybrid" | "fallback") => (arm === "hybrid" ? "hybrid" : "absent") as "hybrid" | "absent";

async function runRecallCase(c: RecallCase): Promise<{ pass: boolean; detail: string }> {
  const client = createEvalClient(dbFrom(c.store, c.messages ?? []), { rpcMode: rpcModeFor(c.arm) });
  if (c.viaSearch) {
    const hits = await searchMemoryEverywhere(client, COMPANY_ID, c.query, { embedder: embedderFor(c.arm) });
    const ids = hits.map((h) => h.id);
    const missing = c.expectIds.filter((id) => !ids.includes(id));
    return { pass: missing.length === 0, detail: `search hits [${ids.join(", ")}]` };
  }
  const result = await retrieveCurrentFacts(client, COMPANY_ID, c.query, { embedder: embedderFor(c.arm) });
  const ids = result.facts.map((fact) => fact.id);
  const missing = c.expectIds.filter((id) => !ids.includes(id));
  if (missing.length > 0) return { pass: false, detail: `missing [${missing.join(", ")}] from [${ids.join(", ")}]` };
  if (c.maxRank != null) {
    const worst = Math.max(...c.expectIds.map((id) => ids.indexOf(id) + 1));
    if (worst > c.maxRank) return { pass: false, detail: `worst rank ${worst} > ${c.maxRank} in [${ids.join(", ")}]` };
  }
  if (c.orderBefore) {
    const [first, second] = c.orderBefore;
    if (!(ids.indexOf(first) < ids.indexOf(second))) {
      return { pass: false, detail: `${first} not before ${second} in [${ids.join(", ")}]` };
    }
  }
  return { pass: true, detail: `mode=${result.mode}` };
}

async function runUpdateCase(c: UpdateCase): Promise<{ pass: boolean; detail: string }> {
  const db = dbFrom(c.seed);
  const client = createEvalClient(db, { rpcMode: rpcModeFor(c.arm) });
  const store = createBotStore(client, COMPANY_ID, "telegram");
  await store.saveMemory(c.save.kind as BotMemoryRow["kind"], c.save.content, {
    supersedesId: c.save.supersedesId,
  });
  const result = await retrieveCurrentFacts(client, COMPANY_ID, c.query, { embedder: embedderFor(c.arm) });
  const currentText = result.facts.map((fact) => fact.content).join("\n");
  if (!currentText.includes(c.newMarker)) {
    return { pass: false, detail: `new value "${c.newMarker}" not in current retrieval: ${currentText}` };
  }
  if (currentText.includes(c.oldMarker)) {
    return { pass: false, detail: `STALE value "${c.oldMarker}" still served as current: ${currentText}` };
  }
  if (c.checkHistory) {
    const hits = await searchMemoryEverywhere(client, COMPANY_ID, c.historyQuery ?? c.query, {
      embedder: embedderFor(c.arm),
    });
    if (!hits.some((h) => h.id === c.oldId)) {
      return { pass: false, detail: `old row ${c.oldId} not findable in history search` };
    }
  }
  return { pass: true, detail: "new current, old in history" };
}

async function runAbstentionCase(c: AbstentionCase): Promise<{ pass: boolean; detail: string }> {
  const client = createEvalClient(dbFrom(STORE_A), { rpcMode: rpcModeFor(c.arm) });
  const result = await retrieveCurrentFacts(client, COMPANY_ID, c.query, { embedder: embedderFor(c.arm) });
  const hits = await searchMemoryEverywhere(client, COMPANY_ID, c.query, { embedder: embedderFor(c.arm) });
  const haystack = [
    ...result.facts.map((fact) => fact.content),
    ...hits.map((h) => h.snippet),
  ]
    .join("\n")
    .toLowerCase();
  const invented = c.absentMarkers.filter((marker) => haystack.includes(marker.toLowerCase()));
  return {
    pass: invented.length === 0,
    detail: invented.length > 0 ? `retrieval surfaced never-stored markers: ${invented.join(", ")}` : "no invented answer in evidence",
  };
}

describe("Phase F fixture arm — recall (single-fact, paraphrase, crossover, multi, temporal)", () => {
  for (const c of RECALL_CASES) {
    it(`${c.id} [${c.category}/${c.arm}] ${c.note}`, async () => {
      let outcome: { pass: boolean; detail: string };
      try {
        outcome = await runRecallCase(c);
      } catch (err) {
        outcome = { pass: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` };
      }
      record(c.category, c.id, outcome.pass);
      expect(outcome.pass, `${c.id} query "${c.query}" — ${outcome.detail}`).toBe(true);
    });
  }
});

describe("Phase F fixture arm — knowledge updates (supersession correctness)", () => {
  for (const c of UPDATE_CASES) {
    it(`${c.id} [update/${c.arm}] ${c.note}`, async () => {
      let outcome: { pass: boolean; detail: string };
      try {
        outcome = await runUpdateCase(c);
      } catch (err) {
        outcome = { pass: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` };
      }
      record("update", c.id, outcome.pass);
      expect(outcome.pass, `${c.id} — ${outcome.detail}`).toBe(true);
    });
  }
});

describe("Phase F fixture arm — abstention (the answer was never stored)", () => {
  for (const c of ABSTENTION_CASES) {
    it(`${c.id} [abstention/${c.arm}] ${c.note}`, async () => {
      let outcome: { pass: boolean; detail: string };
      try {
        outcome = await runAbstentionCase(c);
      } catch (err) {
        outcome = { pass: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` };
      }
      record("abstention", c.id, outcome.pass);
      expect(outcome.pass, `${c.id} query "${c.query}" — ${outcome.detail}`).toBe(true);
    });
  }
});

describe("Phase F fixture arm — contradiction surfacing (conflicts become questions, never silent writes)", () => {
  const NOW = new Date("2026-11-02T08:00:00.000Z");
  const turn = (text: string) => ({
    company_id: COMPANY_ID,
    role: "user",
    text,
    created_at: "2026-11-01T20:00:00.000Z",
    deleted_at: null,
  });
  const memory = (id: string, content: string) => ({
    id,
    company_id: COMPANY_ID,
    kind: "fact",
    content,
    created_at: "2026-10-01T12:00:00.000Z",
    deleted_at: null,
    valid_to: null,
    superseded_by: null,
  });

  async function consolidate(db: EvalDb, candidates: string[]) {
    const client = createEvalClient(db, { rpcMode: "absent" });
    return runConsolidation({
      client,
      companyId: COMPANY_ID,
      isEnabled: async () => true,
      summarize: async () => "A quiet week.",
      extractCandidates: async () => candidates,
      embedder: null,
      now: NOW,
    });
  }

  it("C1: a chat-stated change that contradicts a current fact is staged as an update proposal naming the old row", async () => {
    const db: EvalDb = {
      bot_memories: [memory("c1-old", "Steven settles on Fridays every week")],
      telegram_messages: [turn("Steven settles on Thursdays now, he told me this morning")],
      documents: [],
      bot_pending_actions: [],
      conversation_summaries: [],
      consolidation_runs: [],
    };
    let pass = false;
    let detail = "";
    try {
      const result = await consolidate(db, ["Steven settles on Thursdays every week"]);
      const staged = (db.bot_pending_actions ?? []) as { arguments: Record<string, unknown> }[];
      const memories = (db.bot_memories ?? []) as { valid_to: unknown }[];
      pass =
        result.updatesStaged === 1 &&
        staged.length === 1 &&
        staged[0]?.arguments.supersedes_id === "c1-old" &&
        memories.length === 1 &&
        memories[0]?.valid_to === null;
      detail = `updatesStaged=${result.updatesStaged}, pending=${staged.length}, memories untouched=${memories.length === 1 && memories[0]?.valid_to === null}`;
    } catch (err) {
      detail = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    record("contradiction", "C1", pass);
    expect(pass, `C1 — ${detail}`).toBe(true);
  });

  it("C2: a candidate that merely repeats a current fact is dropped as a duplicate — no proposal, no write", async () => {
    const db: EvalDb = {
      bot_memories: [memory("c2-old", "Detention pays after two hours at the Macon yard")],
      telegram_messages: [turn("Detention pays after two hours at the Macon yard")],
      documents: [],
      bot_pending_actions: [],
      conversation_summaries: [],
      consolidation_runs: [],
    };
    let pass = false;
    let detail = "";
    try {
      const result = await consolidate(db, ["Detention pays after two hours at the Macon yard"]);
      pass =
        result.duplicatesDropped === 1 &&
        result.proposalsStaged === 0 &&
        result.updatesStaged === 0 &&
        (db.bot_pending_actions ?? []).length === 0;
      detail = `dropped=${result.duplicatesDropped}, staged=${result.proposalsStaged + result.updatesStaged}`;
    } catch (err) {
      detail = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    record("contradiction", "C2", pass);
    expect(pass, `C2 — ${detail}`).toBe(true);
  });

  it("C3: a stale claim reappearing in chat does NOT overwrite the current fact — it surfaces as a question", async () => {
    const db: EvalDb = {
      bot_memories: [memory("c3-cur", "Steven settles on Thursdays every week")],
      telegram_messages: [turn("Steven settles on Fridays every week")],
      documents: [],
      bot_pending_actions: [],
      conversation_summaries: [],
      consolidation_runs: [],
    };
    let pass = false;
    let detail = "";
    try {
      const result = await consolidate(db, ["Steven settles on Fridays every week"]);
      const staged = (db.bot_pending_actions ?? []) as { arguments: Record<string, unknown> }[];
      const memories = (db.bot_memories ?? []) as { content: unknown; valid_to: unknown }[];
      pass =
        result.updatesStaged === 1 &&
        staged[0]?.arguments.supersedes_id === "c3-cur" &&
        memories.length === 1 &&
        memories[0]?.content === "Steven settles on Thursdays every week" &&
        memories[0]?.valid_to === null;
      detail = `updatesStaged=${result.updatesStaged}, current fact intact=${memories.length === 1 && memories[0]?.valid_to === null}`;
    } catch (err) {
      detail = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    record("contradiction", "C3", pass);
    expect(pass, `C3 — ${detail}`).toBe(true);
  });
});

describe("Phase F fixture arm — metrics vs design targets", () => {
  it("prints the plain report and fails loudly below target", () => {
    const byGroup = (group: string) => outcomes.filter((o) => o.group === group);
    const rate = (list: Outcome[]) =>
      list.length === 0 ? 0 : list.filter((o) => o.pass).length / list.length;

    const recallGroups = ["recall", "paraphrase", "crossover", "multi", "temporal", "update"];
    const recallOutcomes = outcomes.filter((o) => recallGroups.includes(o.group));
    const abstentionOutcomes = byGroup("abstention");
    const updateOutcomes = byGroup("update");
    const contradictionOutcomes = byGroup("contradiction");

    const recallRate = rate(recallOutcomes);
    const abstentionRate = rate(abstentionOutcomes);
    const failed = outcomes.filter((o) => !o.pass).map((o) => o.id);

    const line = (label: string, list: Outcome[], target: string) =>
      `${label.padEnd(16)} ${String(list.filter((o) => o.pass).length).padStart(2)}/${list.length} = ${Math.round(rate(list) * 100)}% (target ${target})`;
    const report = [
      "",
      "════════ ABEL PHASE F — FIXTURE ARM REPORT ════════",
      line("recall", byGroup("recall"), "—"),
      line("paraphrase", byGroup("paraphrase"), "—"),
      line("crossover", byGroup("crossover"), "—"),
      line("multi", byGroup("multi"), "—"),
      line("temporal", byGroup("temporal"), "—"),
      line("RECALL (all)", recallOutcomes, ">= 90%"),
      line("ABSTENTION", abstentionOutcomes, ">= 95%"),
      line("updates", updateOutcomes, "100% (correctness gate)"),
      line("contradiction", contradictionOutcomes, "100% (correctness gate)"),
      failed.length > 0 ? `failing cases: ${failed.join(", ")}` : "failing cases: none",
      "scope: retrieval/lifecycle CODE vs fixture stores + concept",
      "embedder. Real-model semantics + answer-level abstention are",
      "the live arm's job (live-eval.test.ts, self-skipping).",
      "═══════════════════════════════════════════════════",
      "",
    ].join("\n");
    console.log(report);

    // The golden set itself must stay big enough for the rates to mean something.
    expect(RECALL_CASES.length + UPDATE_CASES.length).toBeGreaterThanOrEqual(25);
    expect(ABSTENTION_CASES.length).toBeGreaterThanOrEqual(20);

    expect(recallRate, `recall ${(recallRate * 100).toFixed(1)}% < 90% target`).toBeGreaterThanOrEqual(0.9);
    expect(abstentionRate, `abstention ${(abstentionRate * 100).toFixed(1)}% < 95% target`).toBeGreaterThanOrEqual(0.95);
    expect(updateOutcomes.every((o) => o.pass), "a knowledge-update case failed — stale fact risk").toBe(true);
    expect(contradictionOutcomes.every((o) => o.pass), "a contradiction case failed — silent-write risk").toBe(true);
  });
});
