-- Frontier 2 (Remember better) — agent autobiography.
--
-- New table agent_episodes: Abel's own record of what he said,
-- recommended, did, got wrong, and learned — the autobiography
-- namespace the plan names. Same conventions as bot_memories:
-- company_id + tenant-isolation RLS, soft delete, bi-temporal
-- supersession (a correction CLOSES the old row, never edits or
-- deletes it), embedding + FTS with hybrid search (abel_search_
-- episodes mirrors abel_search_memories from 00029, RRF k=60).
--
-- Migration replay NOT run on this VM (no Postgres: no psql /
-- pg_ctl / initdb) — validated by careful review against 00029 +
-- 00014, and covered by fake-client tests of the behavioral
-- contract (tenant scoping, current-only reads, supersession).

create extension if not exists vector;

create table agent_episodes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  kind text not null,
  constraint agent_episodes_kind_valid check (
    kind in ('said', 'recommended', 'acted', 'erred', 'learned')
  ),
  summary text not null,
  situation text,
  lesson text,
  valence text,
  constraint agent_episodes_valence_valid check (
    valence is null or valence in ('helped', 'hurt', 'neutral')
  ),
  confidence numeric(3, 2),
  constraint agent_episodes_confidence_range check (
    confidence is null or (confidence >= 0 and confidence <= 1)
  ),
  supersedes_id uuid references agent_episodes (id),
  user_episode_ids uuid[],
  provenance text not null default 'model_inferred_unconfirmed',
  constraint agent_episodes_provenance_valid check (
    provenance in ('owner_stated', 'document', 'owner_confirmed_inference', 'model_inferred_unconfirmed')
  ),
  embedding vector(1536),
  embedding_model text,
  fts tsvector
    generated always as (
      to_tsvector('english', coalesce(summary, '') || ' ' || coalesce(lesson, ''))
    ) stored,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  superseded_by uuid references agent_episodes (id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint agent_episodes_validity_order check (
    valid_to is null or valid_to >= valid_from
  )
);

alter table agent_episodes enable row level security;

create policy "tenant isolation" on agent_episodes
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

create index agent_episodes_current_idx
  on agent_episodes (company_id, kind, created_at desc)
  where deleted_at is null and valid_to is null;
create index agent_episodes_fts_idx on agent_episodes using gin (fts);
create index agent_episodes_embedding_idx
  on agent_episodes using hnsw (embedding vector_cosine_ops);

-- Hybrid search (FTS rank + vector distance fused with reciprocal
-- rank fusion, k=60), mirroring abel_search_memories (00029).
-- A null p_embedding runs the FTS arm alone; a blank query runs
-- the vector arm alone. Both arms are company-scoped and
-- current-episodes-only unless p_include_history is set.
create or replace function abel_search_episodes(
  p_company_id uuid,
  p_query text,
  p_embedding vector(1536),
  p_limit int default 12,
  p_include_history boolean default false
)
returns table (
  id uuid,
  kind text,
  summary text,
  situation text,
  lesson text,
  valence text,
  confidence numeric,
  created_at timestamptz,
  provenance text,
  valid_to timestamptz,
  rrf_score double precision
)
language sql
stable
as $$
  with fts_arm as (
    select e.id, rank() over (order by ts_rank(e.fts, websearch_to_tsquery('english', p_query)) desc) as r
    from agent_episodes e
    where e.company_id = p_company_id
      and e.deleted_at is null
      and (p_include_history or e.valid_to is null)
      and p_query is not null and btrim(p_query) <> ''
      and e.fts @@ websearch_to_tsquery('english', p_query)
    order by ts_rank(e.fts, websearch_to_tsquery('english', p_query)) desc
    limit 50
  ),
  vec_arm as (
    select e.id, rank() over (order by e.embedding <=> p_embedding) as r
    from agent_episodes e
    where e.company_id = p_company_id
      and e.deleted_at is null
      and (p_include_history or e.valid_to is null)
      and p_embedding is not null
      and e.embedding is not null
    order by e.embedding <=> p_embedding
    limit 50
  ),
  fused as (
    select id, sum(1.0 / (60 + r)) as score
    from (select * from fts_arm union all select * from vec_arm) arms
    group by id
  )
  select e.id, e.kind, e.summary, e.situation, e.lesson, e.valence, e.confidence,
         e.created_at, e.provenance, e.valid_to, fused.score
  from fused
  join agent_episodes e on e.id = fused.id
  order by fused.score desc, e.created_at desc
  limit p_limit;
$$;
