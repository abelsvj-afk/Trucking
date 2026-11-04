import { createCrudRoutes } from "@/services/api/crud-routes";
import { createFacilitySchema, updateFacilitySchema } from "@/data/schemas/facilities";
import type { Facility } from "@/types/entities";

const routes = createCrudRoutes<Facility>("facilities", {
  create: createFacilitySchema,
  update: updateFacilitySchema,
});

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
