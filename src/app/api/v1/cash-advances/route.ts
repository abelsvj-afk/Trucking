// Cash advances against a payday (docs/design/employer-pay-profile.md
// section 9). Standard CRUD over cash_advances; the pay figures that net
// against these rows live in lib/cash-advances.ts and the pay-summary.

import { createCrudRoutes } from "@/services/api/crud-routes";
import { createCashAdvanceSchema, updateCashAdvanceSchema } from "@/data/schemas/cash-advances";
import type { CashAdvance } from "@/types/entities";

const routes = createCrudRoutes<CashAdvance>("cash_advances", {
  create: createCashAdvanceSchema,
  update: updateCashAdvanceSchema,
});

export const GET = routes.list;
export const POST = routes.create;
