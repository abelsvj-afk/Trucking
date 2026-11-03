import { createCrudRoutes } from "@/services/api/crud-routes";
import { createBrokerSchema, updateBrokerSchema } from "@/data/schemas/brokers";
import type { Broker } from "@/types/entities";

const routes = createCrudRoutes<Broker>("brokers", {
  create: createBrokerSchema,
  update: updateBrokerSchema,
});

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
