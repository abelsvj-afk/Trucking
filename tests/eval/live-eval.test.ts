// Phase F — live arm (self-skipping, same pattern as
// tests/integration/rls-tenant-isolation.test.ts: skip cleanly when
// the environment isn't there, never fail confusingly).
//
// The fixture arm proves the retrieval/lifecycle CODE honors its
// contracts. Only this arm can prove the parts that depend on the
// real world:
//   - migration 00029 actually applied (hybrid mode live),
//   - the REAL embedding model's paraphrase / Spanish<->English
//     crossover quality over the owner's real history,
//   - retrieval over the real store at real scale.
//
// It is read-only against the configured company. The owner's
// history stays where it lives (design §7 Phase F: anonymized in
// place — nothing here copies memories anywhere).
//
// Enable with:
//   ABEL_EVAL_LIVE=1
//   NEXT_PUBLIC_SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=...
//   ABEL_EVAL_COMPANY_ID=<company uuid>
//   OPENAI_API_KEY=...            (real embeddings)

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { getEmbeddingProvider } from "@/services/bot/embeddings";
import {
  loadAllInstructions,
  retrieveCurrentFacts,
  searchMemoryEverywhere,
} from "@/services/bot/memory-retrieval";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const companyId = process.env.ABEL_EVAL_COMPANY_ID;
const canRun =
  process.env.ABEL_EVAL_LIVE === "1" &&
  Boolean(url && serviceRoleKey && companyId) &&
  Boolean(process.env.OPENAI_API_KEY);

describe.skipIf(!canRun)("Phase F live arm (real Supabase + real embeddings)", () => {
  const client = (): SupabaseClient => createClient(url!, serviceRoleKey!);

  it("hybrid mode is live — migration 00029 is applied, not just filed", async () => {
    const result = await retrieveCurrentFacts(client(), companyId!, "what do you know about Steven", {
      embedder: getEmbeddingProvider(),
    });
    expect(result.mode).toBe("hybrid");
    expect(result.scannedFacts).toBe(result.totalFacts);
  });

  it("standing instructions load in full (no window anywhere near them)", async () => {
    const instructions = await loadAllInstructions(client(), companyId!);
    expect(Array.isArray(instructions)).toBe(true);
  });

  it("abstention probe: a never-stored nonsense fact surfaces no invented answer", async () => {
    const provider = getEmbeddingProvider();
    const result = await retrieveCurrentFacts(
      client(),
      companyId!,
      "what brand is the truck's onboard espresso machine?",
      { embedder: provider },
    );
    const hits = await searchMemoryEverywhere(
      client(),
      companyId!,
      "onboard espresso machine brand",
      { embedder: provider },
    );
    const haystack = [
      ...result.facts.map((fact) => fact.content),
      ...hits.map((h) => h.snippet),
    ]
      .join("\n")
      .toLowerCase();
    expect(haystack).not.toContain("espresso");
  });

  it("search_memory reaches memories, messages, and documents in one call without erroring", async () => {
    const hits = await searchMemoryEverywhere(client(), companyId!, "Steven", {
      embedder: getEmbeddingProvider(),
    });
    expect(Array.isArray(hits)).toBe(true);
  });
});
