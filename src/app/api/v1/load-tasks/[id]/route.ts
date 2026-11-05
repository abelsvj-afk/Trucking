import { createCrudRoutes } from "@/services/api/crud-routes";
import { createLoadTaskSchema, updateLoadTaskSchema } from "@/data/schemas/load-tasks";
import type { LoadTask } from "@/types/entities";

const routes = createCrudRoutes<LoadTask>("load_tasks", { create: createLoadTaskSchema, update: updateLoadTaskSchema });

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
