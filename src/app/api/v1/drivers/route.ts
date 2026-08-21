import { createCrudRoutes } from "@/services/api/crud-routes";
import { createDriverSchema, updateDriverSchema } from "@/data/schemas/drivers";
import type { Driver } from "@/types/entities";

const routes = createCrudRoutes<Driver>("drivers", {
  create: createDriverSchema,
  update: updateDriverSchema,
});

export const GET = routes.list;
export const POST = routes.create;
