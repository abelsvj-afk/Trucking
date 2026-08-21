import { createCrudRoutes } from "@/services/api/crud-routes";
import { createBrokerSchema, updateBrokerSchema } from "@/data/schemas/brokers";
import type { Broker } from "@/types/entities";

const routes = createCrudRoutes<Broker>("brokers", {
  create: createBrokerSchema,
  update: updateBrokerSchema,
});

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
