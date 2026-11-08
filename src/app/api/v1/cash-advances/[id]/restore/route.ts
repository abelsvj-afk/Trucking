import { createCrudRoutes } from "@/services/api/crud-routes";
import { createCashAdvanceSchema, updateCashAdvanceSchema } from "@/data/schemas/cash-advances";
import type { CashAdvance } from "@/types/entities";

const routes = createCrudRoutes<CashAdvance>("cash_advances", {
  create: createCashAdvanceSchema,
  update: updateCashAdvanceSchema,
});

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
