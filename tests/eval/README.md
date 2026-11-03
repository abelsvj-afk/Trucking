# Abel Phase F — evaluation harness

Design: `Trucking-Abel-Intelligence-Upgrade-Design-2026-11-02.md`, Phase F + §8.1.
Purpose: memory quality you can *prove*, re-run on every memory-affecting change,
instead of vibes. This is the F-021/F-039 live-proof machinery in test form.

## What runs where

| Arm | File | Runs in the normal gate? | Proves |
|---|---|---|---|
| Fixture | `eval-harness.test.ts` | Yes — no secrets, no network | The retrieval/lifecycle **code** honors its contracts over seeded stores: current-only filtering, hybrid (FTS+vector RRF) ranking, the fallback arms, budgets/self-report inputs, supersession, contradiction staging. |
| Live | `live-eval.test.ts` | No — self-skips unless `ABEL_EVAL_LIVE=1` + Supabase + OpenAI env (repo's existing skip pattern) | 00029 actually applied (hybrid mode live), the **real** embedding model's paraphrase/crossover quality, behavior over the owner's real store at real scale. Read-only. |

The fixture arm's semantic arm is fed by `fixtures/concept-embedder.ts` — a
deterministic synonym-cluster embedder (EN+ES). It simulates the ONE property
the golden cases test (texts about the same concept score together even with
zero shared words) so paraphrase/crossover cases exercise the production RPC
contract, `fuseRrf`, and context assembly honestly. It does **not** measure
the real model's semantic quality — anyone quoting fixture-arm paraphrase
numbers as real-model numbers is overstating; the report printed by the suite
says this on its face.

## Targets (from the design)

- **Recall@retrieved ≥ 90%** across all answerable cases (single-fact recall,
  paraphrase, crossover, multi-source, temporal, knowledge-update retrieval).
- **Abstention ≥ 95%**: for questions whose answer was never stored, retrieval
  must surface no answer-shaped content. (Fixture level = the *evidence*
  handed to the model contains no invented answer; answer-level abstention —
  Abel actually saying "I don't have that" — is a live/model property.)
- **Knowledge updates 100%** and **contradiction surfacing 100%**: these are
  correctness gates, not rates. A stale fact served as current, or a conflict
  silently written, is the design's named worst failure, so one miss fails
  the suite even if the percentages pass.

The suite prints a plain report (per-category counts + failing case ids) on
every run and fails loudly below target.

## The golden set

`fixtures/golden-set.ts` — seeded fixture stores + cases:

- **Store A** (10 everyday facts) backs the direct-recall and all abstention
  cases; several abstention cases are near-misses (a similar fact exists but
  does not answer the question).
- **Big store** (250 facts) revives the old newest-100 cliff: the oldest and
  a mid-store unique fact must still be retrieved, on the fallback arm.
- **Paraphrase/crossover** queries have zero content-token overlap with their
  target by construction — only the semantic arm can find them.
- **Update cases** write through the real store (`createBotStore.saveMemory`)
  so supersession is exercised end-to-end, not mocked.
- **Contradiction cases** drive the real night shift (`runConsolidation`)
  with a stub extractor: a contradicting candidate must be *staged as a
  question* naming the old row; the store must not change.

## Adding a case

1. Add the seed fact(s) and case object to `golden-set.ts` with the next id
   in its series (`R-` recall, `P` paraphrase, `X` crossover, `M` multi/
   temporal, `U` update, `A` abstention, `C` contradiction — C cases live in
   the harness file because they drive the consolidation job directly).
2. For paraphrase/crossover, verify zero token overlap against the target
   under `tokenSet` semantics (stopwords in `memory-lifecycle.ts`) — if the
   query shares a content word with the fact, it isn't testing meaning.
3. For abstention, verify every marker is absent from the seed store's
   contents (grep it) — a marker that exists in the store invalidates the case.
4. Keep the set ≥ 25 answerable and ≥ 20 abstention cases; the metrics test
   enforces the floors so the percentages stay meaningful.

## Running

```bash
npm test -- tests/eval            # fixture arm (live arm self-skips)
ABEL_EVAL_LIVE=1 NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  ABEL_EVAL_COMPANY_ID=... OPENAI_API_KEY=... npm test -- tests/eval
```
