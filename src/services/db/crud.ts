// Shared CRUD implementation for the MVP entities, per docs/api-contracts.md's
// stated pattern: "every other resource follows this exact shape." Written
// once here instead of copy-pasted per entity, per docs/design/ai-architecture.md's
// same reasoning applied to services/db instead of AI prompts.
//
// Tenant isolation is Postgres RLS (supabase/migrations/), not application
// code - this always operates through the caller's session-scoped client
// (services/db/server.ts), never the service-role key, per
// docs/service-specs.md.
//
// Reliability Unit A additions (design A.4/A.5/A.6): list can serve the
// per-list Deleted view (deletedOnly), softDelete reports whether a row
// was actually affected (a delete of nothing is a 404, not a silent
// 204), restore clears deleted_at as a validated single-row update, and
// findBySubmission backs the idempotent-create dedup lookup.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ListOptions {
  limit?: number;
  offset?: number;
  // Exact-match filters, e.g. { status: "draft" } for loads
  // (docs/api-contracts.md's "loads supports filtering the list endpoint
  // by status"). Kept generic rather than loads-specific since any future
  // entity might need the same thing.
  filters?: Record<string, string>;
  // Deleted view (Unit A / A.4): serve ONLY soft-deleted rows instead of
  // only live ones. The two are never mixed in one response.
  deletedOnly?: boolean;
}

export interface ListResult<Row> {
  data: Row[];
  total: number;
  limit: number;
  offset: number;
}

export function createCrudService<Row extends { id: string }>(table: string) {
  return {
    async list(
      supabase: SupabaseClient,
      options: ListOptions = {},
    ): Promise<ListResult<Row>> {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;

      let query = supabase.from(table).select("*", { count: "exact" });

      query = options.deletedOnly
        ? query.not("deleted_at", "is", null)
        : query.is("deleted_at", null);

      for (const [key, value] of Object.entries(options.filters ?? {})) {
        query = query.eq(key, value);
      }

      const { data, error, count } = await query
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;
      return { data: (data ?? []) as Row[], total: count ?? 0, limit, offset };
    },

    async get(supabase: SupabaseClient, id: string): Promise<Row | null> {
      const { data, error } = await supabase
        .from(table)
        .select("*")
        .eq("id", id)
        .is("deleted_at", null)
        .maybeSingle();

      if (error) throw error;
      return data as Row | null;
    },

    // The row regardless of soft-delete state - restore's starting
    // point. Still RLS-scoped: another company's row is
    // indistinguishable from a nonexistent one (null -> 404).
    async getIncludingDeleted(supabase: SupabaseClient, id: string): Promise<Row | null> {
      const { data, error } = await supabase
        .from(table)
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (error) throw error;
      return data as Row | null;
    },

    // The row a submission token already created, if any (Unit A /
    // A.6). Includes soft-deleted rows on purpose: the idempotency
    // unique index covers them too, so they are what a replay collides
    // with.
    async findBySubmission(
      supabase: SupabaseClient,
      companyId: string,
      submissionId: string,
    ): Promise<Row | null> {
      const { data, error } = await supabase
        .from(table)
        .select("*")
        .eq("company_id", companyId)
        .eq("submission_id", submissionId)
        .maybeSingle();

      if (error) throw error;
      return data as Row | null;
    },

    async create(
      supabase: SupabaseClient,
      companyId: string,
      values: Record<string, unknown>,
    ): Promise<Row> {
      const { data, error } = await supabase
        .from(table)
        .insert({ ...values, company_id: companyId })
        .select("*")
        .single();

      if (error) throw error;
      return data as Row;
    },

    async update(
      supabase: SupabaseClient,
      id: string,
      values: Record<string, unknown>,
    ): Promise<Row | null> {
      const { data, error } = await supabase
        .from(table)
        .update(values)
        .eq("id", id)
        .is("deleted_at", null)
        .select("*")
        .maybeSingle();

      if (error) throw error;
      return data as Row | null;
    },

    // Truthful delete (Unit A / F-005): the update now selects the
    // affected ids, so "nothing was deleted" is a fact the route can
    // act on (404) instead of a silent 204.
    async softDelete(supabase: SupabaseClient, id: string): Promise<boolean> {
      const { data, error } = await supabase
        .from(table)
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .is("deleted_at", null)
        .select("id");

      if (error) throw error;
      return (data ?? []).length > 0;
    },

    // Clears deleted_at on a soft-deleted row. Only the row itself
    // changes; restore never cascades to children or parents (A.4).
    async restore(supabase: SupabaseClient, id: string): Promise<Row | null> {
      const { data, error } = await supabase
        .from(table)
        .update({ deleted_at: null })
        .eq("id", id)
        .not("deleted_at", "is", null)
        .select("*")
        .maybeSingle();

      if (error) throw error;
      return data as Row | null;
    },
  };
}
