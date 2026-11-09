# Dynamic Tool Selection (owner requirement, 2026-11-09 — build #5)

Owner's words: the per-turn tool cap does NOT mean a small toolbox — Abel must know which
tools it needs *in the moment* and pull just those, from a registry that can grow to
thousands. "Which we will."

## The problem

The provider rejects any request carrying more than 128 tools. The registry is 140 tools
(70 read / 70 write) and growing. Since the v64 fix, each turn offers a bounded selection
(`selectToolsForTurn`, ≤120): every write, plus the reads ranked by keyword match against
the owner's message, plus registry-order fill. That kept Abel alive, but it made the
selection a hard ceiling in one specific way: if the router ranked a needed read out of
the top slice, the model could not call it at all — and could honestly report "I can't do
that" for a capability Abel has. As the registry grows toward thousands, first-pass
ranking alone cannot be the whole answer.

## The design

Selection is a first step, never the ceiling:

1. **First-pass selection** (`src/services/bot/tool-budget.ts`) — unchanged shape today:
   all writes offered (a proposal is always possible), reads intent-ranked into the
   remaining room, deterministic, registry order preserved. Two upgrades:
   - Description matching is word-based with the same prefix rule as names — "watching"
     now finds a tool described with "watchers" (substring matching silently ranked the
     research build's `get_knowledge` out of a plain "what have you learned" turn).
   - **Scale branch:** if the WRITE tools alone ever reach the budget, they are
     intent-ranked too (with a reserved slice for matching reads) instead of being
     offered wholesale past the cap.
   - The caller scores selection on the conversation's actual context — the message
     plus the turn's open-loops and running-summary text — not the last message alone.
2. **The catalog** — `runAgentLoop` accepts `toolCatalog`: the FULL registry in the same
   gated/filtered shape as the selection (agent-turn gates the whole registry with
   `gateExecutes` and applies the read-only filter to the catalog too, so a pull can
   never widen what the turn allows — a read-only turn's catalog contains no writes).
3. **`find_more_tools`** — when the catalog holds tools beyond the selection, the loop
   offers this read tool. The model describes the capability it needs; `searchToolCatalog`
   ranks the unoffered catalog by the same intent scoring and the matches load for the
   rest of the turn. The system prompt (`TOOL_SELECTION_RULES`) tells the model its list
   is a selection, to search before ever concluding it cannot do something.
4. **Auto-load on a named tool** — if the model calls a tool that exists in the catalog
   but was not offered, the loop loads it and tells the model to call it again. Not an
   error, never an "I can't."
5. **The cap holds at every moment** — offered specs never exceed the limit (120,
   the finder included): the initial offer is trimmed before the first provider call,
   and making room mid-turn evicts only offered READ tools that have not been called
   and were not themselves pulled. Writes, called tools, pulled tools, and the finder
   are never evicted. An evicted tool is one search away from returning.

Propose→yes is untouched: a pulled write goes through the same staging path as an
offered one (pinned by test).

## Proofs (tests)

- `tests/unit/bot/dynamic-tool-selection.test.ts` — catalog search by description;
  router at 190-tool scale (writes alone past budget); the demonstration turn (first
  selection lacks the needed tool, the turn completes by pulling it); auto-load on a
  named-but-unoffered tool; cap/eviction protection; a pulled write still proposes;
  a read-only catalog can never surface a write.
- `tests/unit/bot/dynamic-tool-selection-scale.test.ts` — against the REAL registry:
  a turn about each major domain (loads, pay, email, research, documents, HOS) gets
  its critical tools in the first selection; context-driven selection (vague message
  + knowledge-thread context surfaces `get_knowledge`); the spec cap from the FIRST
  provider call with a full-budget selection; a synthetic 2,001-tool registry —
  selection capped and deterministic, catalog search finds a deep tool by what it
  does, and a turn at that scale recovers it through `find_more_tools`.
- `tests/unit/bot/tool-budget.test.ts` — the pre-existing budget contract, unchanged.

## Bounds

- No migration. No new registry tools (the finder is loop-internal, not in
  `buildBotTools`, so registry counts and the authority matrix are unaffected).
- Branch only: `feature/dynamic-tool-selection-2026-11-09`, stacked on
  `feature/abel-autonomous-research-2026-11-09`. Re-anchor onto main after the
  research merge, then the owner's merge/deploy taps.
