import { createCrudRoutes } from "@/services/api/crud-routes";
import { createTrailerSchema, updateTrailerSchema } from "@/data/schemas/trailers";
import type { Trailer } from "@/types/entities";

const routes = createCrudRoutes<Trailer>("trailers", {
  create: createTrailerSchema,
  update: updateTrailerSchema,
});

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
