import { createCrudRoutes } from "@/services/api/crud-routes";
import { createFacilitySchema, updateFacilitySchema } from "@/data/schemas/facilities";
import type { Facility } from "@/types/entities";

// GAP-03: facility memory (migration 00053).
const routes = createCrudRoutes<Facility>("facilities", {
  create: createFacilitySchema,
  update: updateFacilitySchema,
});

export const GET = routes.list;
export const POST = routes.create;
