import { createCrudRoutes } from "@/services/api/crud-routes";
import { createExpenseSchema, updateExpenseSchema } from "@/data/schemas/expenses";
import type { Expense } from "@/types/entities";

// UI/UX upgrade: filterableFields: ["load_id"] lets the load detail
// screen pull exactly this load's expenses - the load_id column has
// existed since the table was created; the list endpoint just never
// whitelisted it.
const routes = createCrudRoutes<Expense>(
  "expenses",
  {
    create: createExpenseSchema,
    update: updateExpenseSchema,
  },
  { filterableFields: ["load_id"] },
);

export const GET = routes.list;
export const POST = routes.create;
