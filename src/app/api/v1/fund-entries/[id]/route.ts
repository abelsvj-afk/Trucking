import { createCrudRoutes } from "@/services/api/crud-routes";
import { createFundEntrySchema, updateFundEntrySchema } from "@/data/schemas/fund-entries";
import type { FundEntry } from "@/types/entities";

const routes = createCrudRoutes<FundEntry>(
  "fund_entries",
  { create: createFundEntrySchema, update: updateFundEntrySchema },
  { filterableFields: ["fund_key"] },
);

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
