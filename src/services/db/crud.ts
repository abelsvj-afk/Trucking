// Shared CRUD implementation for the MVP entities, per docs/api-contracts.md's
// stated pattern: "every other resource follows this exact shape." Written
// once here instead of copy-pasted per entity, per docs/design/ai-architecture.md's
// same reasoning applied to services/db instead of AI prompts.
//
// Tenant isolation is Postgres RLS (supabase/migrations/), not application
// code - this always operates through the caller's session-scoped client
// (services/db/server.ts), never the service-role key, per
// docs/service-specs.md.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ListOptions {
  limit?: number;
  offset?: number;
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

      const { data, error, count } = await supabase
        .from(table)
        .select("*", { count: "exact" })
        .is("deleted_at", null)
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

    async softDelete(supabase: SupabaseClient, id: string): Promise<void> {
      const { error } = await supabase
        .from(table)
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .is("deleted_at", null);

      if (error) throw error;
    },
  };
}
