import { createCrudRoutes } from "@/services/api/crud-routes";
import { createBrokerFollowupSchema, updateBrokerFollowupSchema } from "@/data/schemas/broker-followups";
import type { BrokerFollowup } from "@/types/entities";

const routes = createCrudRoutes<BrokerFollowup>("broker-followups", {
  create: createBrokerFollowupSchema,
  update: updateBrokerFollowupSchema,
});

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
