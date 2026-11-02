import { createCrudRoutes } from "@/services/api/crud-routes";
import {
  createDispatchExchangeSchema,
  updateDispatchExchangeSchema,
} from "@/data/schemas/dispatch-exchanges";
import type { DispatchExchange } from "@/types/entities";

const routes = createCrudRoutes<DispatchExchange>("dispatch_exchanges", {
  create: createDispatchExchangeSchema,
  update: updateDispatchExchangeSchema,
});

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
