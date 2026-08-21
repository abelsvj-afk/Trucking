import { createCrudRoutes } from "@/services/api/crud-routes";
import { createExpenseSchema, updateExpenseSchema } from "@/data/schemas/expenses";
import type { Expense } from "@/types/entities";

const routes = createCrudRoutes<Expense>("expenses", {
  create: createExpenseSchema,
  update: updateExpenseSchema,
});

export const GET = routes.list;
export const POST = routes.create;
