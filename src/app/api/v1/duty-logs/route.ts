import { createCrudRoutes } from "@/services/api/crud-routes";
import { createDutyLogSchema, updateDutyLogSchema } from "@/data/schemas/duty-logs";
import type { DutyLog } from "@/types/entities";

const routes = createCrudRoutes<DutyLog>("duty_logs", {
  create: createDutyLogSchema,
  update: updateDutyLogSchema,
});

export const GET = routes.list;
export const POST = routes.create;
