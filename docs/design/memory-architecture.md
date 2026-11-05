# Memory and conversation architecture — as built (2026-11-05, DRAFT for owner review)

Fills the audit gap "no single complete memory design". Everything below is read from `main`; behavior is code-level, not live-verified. Authority rules are in `docs/ai-authority-matrix.md`; this document does not widen them.

## 1. What is stored where
| Store | Table(s) | Holds | Writer |
|---|---|---|---|
| Conversation timeline | `telegram_messages` (both channels, one shared timeline) | every turn, role, channel, text | the webhook / web chat route |
| Long-term memory | `bot_memories` | `kind` ∈ fact · note · expense_hint · instruction · person_profile · business_fact; `provenance`; bi-temporal `valid_from`/`valid_to`, `superseded_by`, `importance`, optional embedding | `save_memory` (proposal or direct order), consolidation proposals (his yes), pay pin / life-phase facts |
| Weekly summaries | `conversation_summaries` | rolling per-week summary + source message ids | night shift |
| Threads / people | `forward_threads`, `forward_thread_messages` (+ person profiles inside `bot_memories`) | reconstructed conversations, participants by **role** (name as data), the ask, language | `record_forward_thread`, thread capture after a dispatch workup |
| Voice corpus | `dispatch_exchanges` (+ `load_decisions`) | incoming text, draft, what he actually sent, edit distance | dispatch workup, `record_sent_reply` |
| Pending actions | `bot_pending_actions` | proposals and asks awaiting yes/no | the agent loop, stage-recordables, consolidation |

## 2. Provenance (who vouched for it)
`owner_stated` · `document` · `owner_confirmed_inference` · `model_inferred_unconfirmed` (DB-constrained). Nothing the model inferred becomes `owner_stated`; inferences enter only as proposals and are saved with the provenance of how the owner confirmed them.

## 3. Lifecycle
- A new fact never edits or deletes an old row: it **closes** it (`valid_to`, `superseded_by`), so "what did he used to say?" stays answerable.
- Structured lines have identity: `BUSINESS — <subject> | …` supersedes same-subject; `PERSON — <name> | role: … | …` supersedes only when **name and role both match** (two people can share a name; an unconfirmable same-name profile becomes an update proposal, never a silent close).
- Plain facts supersede only when a caller names the row; similarity never closes a row by itself.
- Instructions (procedural memory) are always loaded in full — never relevance-filtered or windowed.
- Delete/forget: the owner can remove memories from More → Memories and via the delete proposal path (soft delete, restorable by the Unit A lifecycle). Abel never deletes a memory on his own.

## 4. Retrieval
Hybrid search inside Postgres (FTS + pgvector fused by reciprocal rank, migration 00029) over **all** current facts; fallback = keyword scan of the newest 1,000 current rows, and the fallback **discloses itself** in the context report line. Budget: ≤ 12 facts / ~600 tokens per turn; any truncation is stated ("showing X of Y"). Context blocks are assembled in code (instructions, retrieved facts, weekly summary, pay pin, life phase with the employer read from stored pay terms, open loops from threads, pending proposal/batch/photo ask, outstanding pre-trip photo asks, tool-grounded snapshot) — never model-elected.

## 5. Consolidation (night shift, `memory_consolidation`)
Embeds un-embedded rows, refreshes weekly summaries, finds semantic candidates in recent chat, and **stages** them as morning proposals; near-duplicates (similarity ≥ 0.9) are dropped; 0.4–0.9 with different text become "change X to Y?" update proposals. It never saves a memory directly. Off = no writes at all.

## 6. Permissions and privacy
Owner-only chat; every row company-scoped; service-role path is code-scoped (matrix in `docs/reconciliation/wave-4-test-matrix.md`). No memory is shared with a third party. Audio and images go to the configured provider only when the corresponding capability is on.

## 7. Evaluation (to build in Wave 4)
Golden cases for: grounding (no figure absent from tool results), supersession (old fact answerable, new fact wins), same-name different-person, instruction always present, truncation disclosure, stale-proposal handling, forwarded-text injection.

## 8. Decisions needed (owner)
- **Retention:** how long to keep `telegram_messages`, superseded memories and weekly summaries (today: forever). (D-8)
- **"Forget this" intent:** should Abel accept a plain-language forget request and *propose* the soft delete (never execute)? (D-9)
