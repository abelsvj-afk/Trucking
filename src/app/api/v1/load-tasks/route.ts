import { createCrudRoutes } from "@/services/api/crud-routes";
import { createLoadTaskSchema, updateLoadTaskSchema } from "@/data/schemas/load-tasks";
import type { LoadTask } from "@/types/entities";

// Trip intake: the dispatcher's requirements for a load, read per load.
const routes = createCrudRoutes<LoadTask>(
  "load_tasks",
  { create: createLoadTaskSchema, update: updateLoadTaskSchema },
  { filterableFields: ["load_id"] },
);

export const GET = routes.list;
export const POST = routes.create;
