import { createCrudRoutes } from "@/services/api/crud-routes";
import { createRecurringObligationSchema, updateRecurringObligationSchema } from "@/data/schemas/recurring-obligations";
import type { RecurringObligation } from "@/types/entities";

// GAP-13: recurring obligations (migration 00056).
const routes = createCrudRoutes<RecurringObligation>("recurring-obligations", {
  create: createRecurringObligationSchema,
  update: updateRecurringObligationSchema,
});

export const GET = routes.list;
export const POST = routes.create;
