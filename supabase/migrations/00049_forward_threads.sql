-- Abel Intelligence Upgrade, Phase C — forwarded-thread
-- intelligence (design Trucking-Abel-Intelligence-Upgrade-Design-
-- 2026-11-02 §4). Numbered 00049 in the wave renumber (2026-11-04).
-- Independent of the other migrations; may apply before or after any safely.
--
-- A forwarded conversation stops being a blob: it becomes a stored
-- thread record - participants with roles, a message timeline, the
-- ask and of whom, the deadline in play, and whether the ask is
-- still unanswered (the open loop). Follow-up forwards from the
-- same conversation APPEND to the same thread (matching is done in
-- code, services/bot/threads.ts - participant overlap on an open
-- thread - never re-derived from scratch by a model each time).
--
-- Language discipline (§11) is preserved in the shape: message
-- bodies are stored VERBATIM (English is never translated, ever),
-- and each message carries its own language tag so mixed threads
-- are handled per message, not per thread.

create table forward_threads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  /** Short label for the thread (first ask / counterparty), when known. */
  title text,
  status text not null default 'open'
    check (status in ('open', 'closed')),
  /** Dominant language of the thread: en | es | mixed. */
  language text check (language in ('en', 'es', 'mixed')),
  /** What is being asked, in one plain sentence, when the thread carries an ask. */
  the_ask text,
  /** Who the ask is OF (a participant name - usually the owner). */
  ask_of text,
  /** The deadline / appointment in play, as written or parsed ("Friday 6pm", "2026-11-06"). */
  deadline_text text,
  /** [{name, role}] - role: carrier_dispatch | steven | broker | shipper | receiver | owner | other. Matched to person_profile memories where known (services/bot/threads.ts). */
  participants jsonb not null default '[]'::jsonb,
  /** The open loop: true while the thread's ask has no recorded answer. */
  unanswered boolean not null default false,
  /** The dispatch exchange this thread's latest segment produced (voice-corpus link, design §4 acceptance 4). */
  last_exchange_id uuid references dispatch_exchanges (id),
  /** How the thread arrived: forward | paste | photo | chat. */
  source text not null default 'forward'
    check (source in ('forward', 'paste', 'photo', 'chat')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index forward_threads_company_open_idx
  on forward_threads (company_id, status, updated_at desc)
  where deleted_at is null;

alter table forward_threads enable row level security;

create policy "tenant isolation" on forward_threads
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

create table forward_thread_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  thread_id uuid not null references forward_threads (id),
  sender_name text not null,
  /** The sender's role in this thread (same vocabulary as participants). */
  sender_role text,
  /** The message body, VERBATIM as forwarded - never translated, never rewritten (§11). */
  body text not null,
  /** This message's own language: en | es | unknown. */
  language text check (language in ('en', 'es', 'unknown')),
  /** When the message was sent, when the forward carries it. */
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index forward_thread_messages_thread_idx
  on forward_thread_messages (company_id, thread_id, created_at)
  where deleted_at is null;

create index forward_thread_messages_sender_idx
  on forward_thread_messages (company_id, sender_name)
  where deleted_at is null;

alter table forward_thread_messages enable row level security;

create policy "tenant isolation" on forward_thread_messages
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
