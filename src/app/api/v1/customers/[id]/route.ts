import { createCrudRoutes } from "@/services/api/crud-routes";
import { createCustomerSchema, updateCustomerSchema } from "@/data/schemas/customers";
import type { Customer } from "@/types/entities";

const routes = createCrudRoutes<Customer>("customers", {
  create: createCustomerSchema,
  update: updateCustomerSchema,
});

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
