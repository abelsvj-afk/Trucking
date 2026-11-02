import { createCrudRoutes } from "@/services/api/crud-routes";
import { createTrailerSchema, updateTrailerSchema } from "@/data/schemas/trailers";
import type { Trailer } from "@/types/entities";

const routes = createCrudRoutes<Trailer>("trailers", {
  create: createTrailerSchema,
  update: updateTrailerSchema,
});

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
