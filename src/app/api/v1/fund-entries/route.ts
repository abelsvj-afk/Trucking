// Fund ledger entries (docs/design/driver-mvp.md §9.1). Standard
// CRUD over fund_entries; the list is filterable by fund_key so a
// single fund's log is one query. Recording a suggestion is just a
// POST here with source: "sweep" - the app writes the ledger row and
// nothing else moves, ever.

import { createCrudRoutes } from "@/services/api/crud-routes";
import { createFundEntrySchema, updateFundEntrySchema } from "@/data/schemas/fund-entries";
import type { FundEntry } from "@/types/entities";

const routes = createCrudRoutes<FundEntry>(
  "fund_entries",
  { create: createFundEntrySchema, update: updateFundEntrySchema },
  { filterableFields: ["fund_key"] },
);

export const GET = routes.list;
export const POST = routes.create;
