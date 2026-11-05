# Event, tool and lifecycle contracts (Phase 6 supplement) — 2026-11-05 (DRAFT)

Fills the audit's "Event/tool contracts" gap. Read from `main`; not live-verified.

## 1. Realtime (`postgres_changes`)
Publication `supabase_realtime` carries: `duty_logs, loads, expenses, fuel_purchases, maintenance_events, maintenance_schedules, trucks, trailers, drivers, documents, detention_stamps, bot_pending_actions, research_briefings, research_signals` (00058) + `load_tasks` (00061) + `load_stops` (00062). Source of truth for the client list: `src/lib/live-tables.ts` (a test pins 00058+later migrations to it). Contract: an event only triggers a **re-fetch through the company-scoped API**; its payload is never rendered. RLS SELECT policies scope delivery. Without the publication the app behaves as before (fetch on open/focus; no "Live" badge).

## 2. Telegram updates (webhook)
Gates in order: bot token present → webhook secret → JSON body → chat present → private chat → owner allowlist (else setup-mode message) → dedup claim (`telegram_processed_updates`; released if the turn throws). Then by kind: `callback_query` (photo-purpose buttons) · `message.location` / `edited_message.location` (Live Location → `handleLocation`; **never replied to in chat**) · photo/document · voice · text (dispatch workup if forwarded, else Abel). Result codes are the `TelegramHandleResult` union. Always HTTP 200 once accepted.

## 3. Pending-action (proposal) lifecycle
`bot_pending_actions` row = {tool, arguments (validated), summary, channel, optional batch id/item number}. States by presence: **open** → *executed* (row cleared, then write; on write failure the proposal is re-staged) / *cancelled* (cleared) / *expired* (>2 h; dropped silently at next turn). Targeting: a bare yes/no resolves the newest shown group; ambiguity (>1 open group, newest older than 10 min) executes nothing and lists. Batches resolve by command (all / by number / drop). Photo-purpose asks are a separate pending kind with their own expiry. Never auto-execute.

## 4. Tool contract
Each tool: name, JSON-schema parameters, `access` read|write, optional `validateArgs` (Zod; run **before** a proposal is shown), `summarize` (the text the owner sees), `run`. Writes: `confirmation: "execute"` only for a direct owner order, else proposed; `alwaysPropose` tools (delete_record, set_pay_terms, stage_dump_items) ignore execute. Registry: `docs/ai-authority-matrix.md` §6.

## 5. Scheduler / invoker contract
Six in-process schedulers (industry briefing, research, game plan, consolidation, pay report, maintenance watch) + `/api/internal/*` invokers (secret header, fail closed). Each tick: read switch → compute due-ness from DB rows → act → record run. A disabled switch means the tick does nothing; global switch disables all. Heartbeat/run tables: `research_runner_heartbeat`, `*_runs`, `maintenance_watch_runs`, `consolidation_runs`, `pay_report_runs`.

## 6. Notification contract (Telegram → owner only)
Research alerts: urgent/trip/routine classes; quiet hours 21:00–06:00 ET delay routine, urgent bypass. Pay report: weekly, only if data. Maintenance: one digest/day, urgent immediately. Consolidation: report. Game plan: checkpoint notes. No notification goes to anyone but the owner's chat.
