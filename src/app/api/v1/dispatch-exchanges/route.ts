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

export const GET = routes.list;
export const POST = routes.create;
