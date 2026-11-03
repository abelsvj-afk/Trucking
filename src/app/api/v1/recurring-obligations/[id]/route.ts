import { createCrudRoutes } from "@/services/api/crud-routes";
import { createRecurringObligationSchema, updateRecurringObligationSchema } from "@/data/schemas/recurring-obligations";
import type { RecurringObligation } from "@/types/entities";

const routes = createCrudRoutes<RecurringObligation>("recurring-obligations", {
  create: createRecurringObligationSchema,
  update: updateRecurringObligationSchema,
});

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
