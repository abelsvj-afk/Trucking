import { createCrudRoutes } from "@/services/api/crud-routes";
import { createFundEntrySchema, updateFundEntrySchema } from "@/data/schemas/fund-entries";
import type { FundEntry } from "@/types/entities";

const routes = createCrudRoutes<FundEntry>(
  "fund_entries",
  { create: createFundEntrySchema, update: updateFundEntrySchema },
  { filterableFields: ["fund_key"] },
);

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
