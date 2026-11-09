# Abel — Autonomous Research & Business Awareness (design, 2026-11-09)

Owner spec: `Abel-Autonomous-Research-Spec-2026-11-09.md` (goal files).
This build extends the Deep Research engine (docs/design/research-engine.md)
and Research Intelligence (00040/00051) — it does NOT rebuild them.

## What already existed (reused, untouched)

- Watchers: EIA diesel (national + regional), Federal Register, industry
  news (Google News RSS), FRED market snapshot, GDELT geo/tech, NWS
  weather, OpenStates — polled hourly by the research tick (in-process
  scheduler + pg_cron-invoked internal endpoint), signals archived in
  `research_signals`, health in `research_watcher_state`.
- Trigger engine (hard thresholds + convergence + baseline cadence) and
  the runner: capped, kill-switched, every outcome landed in
  `research_runs`; briefings in `research_briefings` with sourced,
  dated findings and per-section imagery; Telegram delivery under the
  D-6 timing rules.
- Abel's R-6 access: `list_research_briefings`, `get_research_briefing`,
  `list_research_requests`, `queue_research` (a manual run row, executed
  by the tick under the same caps), `request_pretrip_photos`.
- `bot_memories` with the staleness discipline (lib/staleness.ts):
  time-bound facts show their age; nothing old is asserted as current.

## What this build adds

1. **Standing watch topics** (`src/lib/watch-topics.ts`) — one registry
   naming the five things Abel keeps awareness of, in plain words, each
   with its sources and how long a fact stays "current":
   `own_business` (his records), `industry` (diesel, regulation, rates,
   carrier news), `crypto` (BTC/XRP awareness ONLY — never trading
   advice, never touching his loans; the stock market is a SEPARATE
   domain, watched by the FRED snapshot, and is out of this build's
   scope), `authority_pathways` (own truck + MC authority steps/costs),
   `build_plan` (his phased plan, held as knowledge to reason against).
2. **Crypto snapshot watcher** (`watchers/crypto-snapshot.ts`) — one
   daily observation from CoinGecko's free keyless public API (BTC +
   XRP USD price + 24h move). Awareness-only by construction: topic
   `crypto`, magnitude 0.25 from a single source, which can never cross
   the convergence fire line (1.6) or any hard trigger — it informs, it
   never fires a run by itself. A failed poll lands as a visible
   watcher error, never a fabricated price.
3. **Durable knowledge** (`research_knowledge`, migration 00084) — the
   tick distills every fresh signal into a per-company knowledge row
   (title, content, source title + URL, observed_at, dedupe key), plus
   a daily **own-business snapshot** built from his own records
   (loads/miles/revenue in the last 30 days, expenses, top lanes, and
   his current pay-profile terms read as DATA — rate and basis, or
   visibly UNSET; no employer name, no rate constant anywhere in code).
   Freshness is computed in code per topic window
   (`knowledgeFreshness`): current / aging / stale / none — stale
   knowledge is quoted as background with its date, never as current.
4. **Self-directed learning agenda** (`research_learning_topics`,
   migration 00084) — the tick's agenda pass compares knowledge
   freshness per standing topic and files PROPOSED topics (dedupe: one
   open proposal per topic; capped per tick). Proposals surface in
   chat (`list_learning_topics`) and on the Research page ("What Abel
   is watching"). Approval — in chat via `approve_learning_topic` or
   the page button — queues a normal manual Deep Research run under
   the engine's caps and marks the topic queued; the runner settles
   the topic to `done` when that run finishes (any terminal outcome is
   recorded honestly). Dismissal is one tap / one tool call. Abel can
   also originate a proposal in conversation (`propose_learning_topic`)
   when he notices a gap mid-chat; it goes through the same
   propose→yes gate as every write. Research stays read-only learning:
   it never moves money, changes records, or sends anything —
   actionable findings return as proposals, as always.
5. **Chat connection** — new read tools `list_watch_topics` (what Abel
   is watching, why, and how fresh each picture is, in plain words)
   and `get_knowledge` (stored knowledge by topic/keyword WITH source,
   Eastern date, and freshness label; when the picture is thin or
   stale the tool output says so in words the answer must relay
   instead of guessing). The agent prompt's RESEARCH paragraph names
   the standing watch, the agenda discipline, and the crypto/stock
   domain separation.

## Surfaces

- Telegram/web chat: the four tools above + prompt guidance.
- App: Research page gains a "What Abel is watching" panel (topics,
  freshness, latest knowledge line per topic) and the learning-agenda
  list with Approve / Dismiss buttons, fed by
  `GET /api/v1/watch-picture` and
  `POST /api/v1/learning-topics/[id]/approve|dismiss` (owner session,
  RLS-fenced like the briefing routes).

## Where a future agent workspace plugs in

Background jobs run on the app's existing infrastructure (the research
tick). The agenda/knowledge writers take a `Queryable`, so a future
per-agent cloud workspace (Oracle Always Free home base — owner
card-verification signup, NOT part of this build) can run the same
passes off-process by calling the same modules with its own pool; no
schema or contract change is needed. Nothing in this build signs up
for, provisions, or depends on any external workspace.

## Bounds kept

Branch only; migration 00084 authored, NOT applied. Free sources only
(CoinGecko keyless). No UTC in user-facing text (America/New_York).
Applied migrations 00001–00083 untouched.
