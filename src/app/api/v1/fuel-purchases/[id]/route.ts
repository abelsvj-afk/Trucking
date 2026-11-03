import { createCrudRoutes } from "@/services/api/crud-routes";
import { createFuelPurchaseSchema, updateFuelPurchaseSchema } from "@/data/schemas/fuel-purchases";
import { prepareFuelUpdate } from "@/services/api/fuel-write";
import type { FuelPurchase } from "@/types/entities";

const routes = createCrudRoutes<FuelPurchase>("fuel_purchases", {
  create: createFuelPurchaseSchema,
  update: updateFuelPurchaseSchema,
}, {
  // Unit C (D-04): every update re-derives the total from the merged
  // record (fuel-write.ts).
  prepareUpdate: prepareFuelUpdate,
});

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
