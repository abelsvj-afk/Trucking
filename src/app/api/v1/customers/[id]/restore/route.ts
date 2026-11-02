import { createCrudRoutes } from "@/services/api/crud-routes";
import { createCustomerSchema, updateCustomerSchema } from "@/data/schemas/customers";
import type { Customer } from "@/types/entities";

const routes = createCrudRoutes<Customer>("customers", {
  create: createCustomerSchema,
  update: updateCustomerSchema,
});

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
