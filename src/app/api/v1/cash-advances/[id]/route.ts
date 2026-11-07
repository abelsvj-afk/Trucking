import { createCrudRoutes } from "@/services/api/crud-routes";
import { createCashAdvanceSchema, updateCashAdvanceSchema } from "@/data/schemas/cash-advances";
import type { CashAdvance } from "@/types/entities";

const routes = createCrudRoutes<CashAdvance>("cash_advances", {
  create: createCashAdvanceSchema,
  update: updateCashAdvanceSchema,
});

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
