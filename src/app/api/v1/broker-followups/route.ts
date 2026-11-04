import { createCrudRoutes } from "@/services/api/crud-routes";
import { createBrokerFollowupSchema, updateBrokerFollowupSchema } from "@/data/schemas/broker-followups";
import type { BrokerFollowup } from "@/types/entities";

// GAP-14: broker follow-ups (migration 00057).
const routes = createCrudRoutes<BrokerFollowup>("broker-followups", {
  create: createBrokerFollowupSchema,
  update: updateBrokerFollowupSchema,
});

export const GET = routes.list;
export const POST = routes.create;
