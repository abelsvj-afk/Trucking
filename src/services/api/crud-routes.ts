// Generates the 5 standard routes from docs/api-contracts.md
// (list/get/create/update/soft-delete) for one resource, wired through
// createApiHandler (auth + error handling) and the entity's own Zod
// schemas (validation). Every MVP entity's route.ts files are a few lines
// that call this - see src/app/api/v1/trucks/ for the worked example.

import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { createApiHandler } from "./handler";
import { validateBody } from "./validate";
import { notFound } from "./errors";
import { createClient } from "@/services/db/server";
import { createCrudService } from "@/services/db/crud";

export function createCrudRoutes<Row extends { id: string }>(
  table: string,
  schemas: { create: z.ZodType<Record<string, unknown>>; update: z.ZodType<Record<string, unknown>> },
  // Query-param names allowed as exact-match list filters, e.g. ["status"]
  // for loads (docs/api-contracts.md). Empty by default - most entities
  // don't need this.
  options: { filterableFields?: string[] } = {},
) {
  const crud = createCrudService<Row>(table);
  const filterableFields = options.filterableFields ?? [];

  const list = createApiHandler(async (req: NextRequest) => {
    const supabase = await createClient();
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    const filters: Record<string, string> = {};
    for (const field of filterableFields) {
      const value = url.searchParams.get(field);
      if (value) filters[field] = value;
    }

    const result = await crud.list(supabase, { limit, offset, filters });
    return NextResponse.json({
      data: result.data,
      page: { limit: result.limit, offset: result.offset, total: result.total },
    });
  });

  const create = createApiHandler(async (req, ctx) => {
    const supabase = await createClient();
    const body = await validateBody(req, schemas.create);
    const row = await crud.create(supabase, ctx.auth.companyId, body);
    return NextResponse.json(row, { status: 201 });
  });

  const getOne = createApiHandler(async (_req, ctx) => {
    const supabase = await createClient();
    const row = await crud.get(supabase, ctx.params.id!);
    if (!row) throw notFound();
    return NextResponse.json(row);
  });

  const update = createApiHandler(async (req, ctx) => {
    const supabase = await createClient();
    const body = await validateBody(req, schemas.update);
    const row = await crud.update(supabase, ctx.params.id!, body);
    if (!row) throw notFound();
    return NextResponse.json(row);
  });

  const remove = createApiHandler(async (_req, ctx) => {
    const supabase = await createClient();
    await crud.softDelete(supabase, ctx.params.id!);
    return new NextResponse(null, { status: 204 });
  });

  return { list, create, getOne, update, remove };
}
