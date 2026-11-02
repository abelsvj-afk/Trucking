-- Lane 2 — Abel Intelligence Upgrade, Phase A+B schema
-- (Trucking-Abel-Intelligence-Upgrade-Design-2026-11-02, §3.4/§3.5/§7).
-- NOT applied by the build lane: this file ships in the branch for
-- the owner's own migration run, exactly like every migration here.
--
-- What it adds:
-- 1. Bi-temporal lifecycle on bot_memories: valid_from / valid_to /
--    superseded_by (a new fact CLOSES the old row; nothing is edited
--    or deleted), plus importance and provenance (who vouched for
--    the fact: owner_stated > document > owner_confirmed_inference
--    > model_inferred_unconfirmed).
-- 2. Hybrid retrieval: a generated FTS tsvector + a pgvector
--    embedding on bot_memories, telegram_messages, and
--    dispatch_exchanges; documents gain an embedding (their FTS
--    already exists as extracted_tsv, 00022 + caption in 00033).
--    embedding_model is recorded on every embedded row - mixing
--    embedding models in one index silently corrupts retrieval, so
--    the model that produced each vector travels with it.
-- 3. Three hybrid search functions (FTS rank + vector distance
--    fused with reciprocal rank fusion, k=60) the retrieval service
--    calls. Each takes an explicit company scope; RLS still applies
--    to session clients, and the service-role bot path passes the
--    one company it is scoped to.

create extension if not exists vector;

-- ----------------------------------------------------------------
-- bot_memories lifecycle + retrieval columns
-- ----------------------------------------------------------------

alter table bot_memories
  add column valid_from timestamptz,
  add column valid_to timestamptz,
  add column superseded_by uuid references bot_memories (id),
  add column importance int not null default 3,
  add column provenance text not null default 'owner_stated',
  add column embedding vector(1536),
  add column embedding_model text,
  add column fts tsvector
    generated always as (to_tsvector('english', content)) stored;

update bot_memories set valid_from = created_at where valid_from is null;
alter table bot_memories alter column valid_from set default now();
alter table bot_memories alter column valid_from set not null;

alter table bot_memories
  add constraint bot_memories_importance_range check (importance between 1 and 5),
  add constraint bot_memories_provenance_valid check (
    provenance in ('owner_stated', 'document', 'owner_confirmed_inference', 'model_inferred_unconfirmed')
  ),
  add constraint bot_memories_validity_order check (valid_to is null or valid_to >= valid_from);

create index bot_memories_current_idx
  on bot_memories (company_id, kind, created_at desc)
  where deleted_at is null and valid_to is null;
create index bot_memories_fts_idx on bot_memories using gin (fts);
create index bot_memories_embedding_idx
  on bot_memories using hnsw (embedding vector_cosine_ops);

-- ----------------------------------------------------------------
-- Episodic stores: embeddings + FTS so week-1 words are reachable
-- in week 6 (design §3.5, conversation block).
-- ----------------------------------------------------------------

alter table telegram_messages
  add column embedding vector(1536),
  add column embedding_model text,
  add column fts tsvector
    generated always as (to_tsvector('english', text)) stored;

create index telegram_messages_fts_idx on telegram_messages using gin (fts);
create index telegram_messages_embedding_idx
  on telegram_messages using hnsw (embedding vector_cosine_ops);

alter table dispatch_exchanges
  add column embedding vector(1536),
  add column embedding_model text,
  add column fts tsvector
    generated always as (
      to_tsvector('english', coalesce(incoming_message, '') || ' ' || coalesce(actual_reply_sent, ''))
    ) stored;

create index dispatch_exchanges_fts_idx on dispatch_exchanges using gin (fts);
create index dispatch_exchanges_embedding_idx
  on dispatch_exchanges using hnsw (embedding vector_cosine_ops);

alter table documents
  add column embedding vector(1536),
  add column embedding_model text;

create index documents_embedding_idx
  on documents using hnsw (embedding vector_cosine_ops);

-- ----------------------------------------------------------------
-- Hybrid search (reciprocal rank fusion over FTS + vector arms).
-- A null p_embedding simply runs the FTS arm alone; a blank query
-- runs the vector arm alone. Both arms are company-scoped and, for
-- memories, current-facts-only unless p_include_history is set.
-- ----------------------------------------------------------------

create or replace function abel_search_memories(
  p_company_id uuid,
  p_query text,
  p_embedding vector(1536),
  p_limit int default 12,
  p_include_history boolean default false
)
returns table (
  id uuid,
  kind text,
  content text,
  created_at timestamptz,
  importance int,
  provenance text,
  valid_to timestamptz,
  rrf_score double precision
)
language sql
stable
as $$
  with fts_arm as (
    select m.id, rank() over (order by ts_rank(m.fts, websearch_to_tsquery('english', p_query)) desc) as r
    from bot_memories m
    where m.company_id = p_company_id
      and m.deleted_at is null
      and (p_include_history or m.valid_to is null)
      and p_query is not null and btrim(p_query) <> ''
      and m.fts @@ websearch_to_tsquery('english', p_query)
    order by ts_rank(m.fts, websearch_to_tsquery('english', p_query)) desc
    limit 50
  ),
  vec_arm as (
    select m.id, rank() over (order by m.embedding <=> p_embedding) as r
    from bot_memories m
    where m.company_id = p_company_id
      and m.deleted_at is null
      and (p_include_history or m.valid_to is null)
      and p_embedding is not null
      and m.embedding is not null
    order by m.embedding <=> p_embedding
    limit 50
  ),
  fused as (
    select id, sum(1.0 / (60 + r)) as score
    from (select * from fts_arm union all select * from vec_arm) arms
    group by id
  )
  select m.id, m.kind, m.content, m.created_at, m.importance, m.provenance, m.valid_to,
         fused.score
  from fused
  join bot_memories m on m.id = fused.id
  order by fused.score desc, m.importance desc, m.created_at desc
  limit p_limit;
$$;

create or replace function abel_search_messages(
  p_company_id uuid,
  p_query text,
  p_embedding vector(1536),
  p_limit int default 8
)
returns table (
  id uuid,
  role text,
  text text,
  created_at timestamptz,
  channel text,
  rrf_score double precision
)
language sql
stable
as $$
  with fts_arm as (
    select t.id, rank() over (order by ts_rank(t.fts, websearch_to_tsquery('english', p_query)) desc) as r
    from telegram_messages t
    where t.company_id = p_company_id
      and t.deleted_at is null
      and p_query is not null and btrim(p_query) <> ''
      and t.fts @@ websearch_to_tsquery('english', p_query)
    order by ts_rank(t.fts, websearch_to_tsquery('english', p_query)) desc
    limit 50
  ),
  vec_arm as (
    select t.id, rank() over (order by t.embedding <=> p_embedding) as r
    from telegram_messages t
    where t.company_id = p_company_id
      and t.deleted_at is null
      and p_embedding is not null
      and t.embedding is not null
    order by t.embedding <=> p_embedding
    limit 50
  ),
  fused as (
    select id, sum(1.0 / (60 + r)) as score
    from (select * from fts_arm union all select * from vec_arm) arms
    group by id
  )
  select t.id, t.role, t.text, t.created_at, t.channel, fused.score
  from fused
  join telegram_messages t on t.id = fused.id
  order by fused.score desc, t.created_at desc
  limit p_limit;
$$;

create or replace function abel_search_documents(
  p_company_id uuid,
  p_query text,
  p_embedding vector(1536),
  p_limit int default 8
)
returns table (
  id uuid,
  file_name text,
  extracted_text text,
  created_at timestamptz,
  rrf_score double precision
)
language sql
stable
as $$
  with fts_arm as (
    select d.id, rank() over (order by ts_rank(d.extracted_tsv, websearch_to_tsquery('english', p_query)) desc) as r
    from documents d
    where d.company_id = p_company_id
      and p_query is not null and btrim(p_query) <> ''
      and d.extracted_tsv @@ websearch_to_tsquery('english', p_query)
    order by ts_rank(d.extracted_tsv, websearch_to_tsquery('english', p_query)) desc
    limit 50
  ),
  vec_arm as (
    select d.id, rank() over (order by d.embedding <=> p_embedding) as r
    from documents d
    where d.company_id = p_company_id
      and p_embedding is not null
      and d.embedding is not null
    order by d.embedding <=> p_embedding
    limit 50
  ),
  fused as (
    select id, sum(1.0 / (60 + r)) as score
    from (select * from fts_arm union all select * from vec_arm) arms
    group by id
  )
  -- No caption column reference here on purpose: caption arrives in
  -- 00033 (AFTER this migration), but it is folded into extracted_tsv
  -- there, so the FTS arm above searches captions automatically once
  -- both migrations are in. A direct column reference would make
  -- this function fail to create on a database at 00029.
  select d.id, d.file_name, d.extracted_text, d.created_at, fused.score
  from fused
  join documents d on d.id = fused.id
  order by fused.score desc, d.created_at desc
  limit p_limit;
$$;
