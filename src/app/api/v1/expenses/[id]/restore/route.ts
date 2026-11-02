import { createCrudRoutes } from "@/services/api/crud-routes";
import { createExpenseSchema, updateExpenseSchema } from "@/data/schemas/expenses";
import type { Expense } from "@/types/entities";

const routes = createCrudRoutes<Expense>("expenses", {
  create: createExpenseSchema,
  update: updateExpenseSchema,
});

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
