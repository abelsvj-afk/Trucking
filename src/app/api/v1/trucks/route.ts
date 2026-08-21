import { createCrudRoutes } from "@/services/api/crud-routes";
import { createTruckSchema, updateTruckSchema } from "@/data/schemas/trucks";
import type { Truck } from "@/types/entities";

const routes = createCrudRoutes<Truck>("trucks", {
  create: createTruckSchema,
  update: updateTruckSchema,
});

export const GET = routes.list;
export const POST = routes.create;
