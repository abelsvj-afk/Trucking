import { createCrudRoutes } from "@/services/api/crud-routes";
import { createDutyLogSchema, updateDutyLogSchema } from "@/data/schemas/duty-logs";
import type { DutyLog } from "@/types/entities";

// UI/UX upgrade: filterableFields: ["load_id"] lets the load detail
// screen count exactly this load's duty entries - same reasoning as
// expenses (the column existed; the whitelist didn't).
const routes = createCrudRoutes<DutyLog>(
  "duty_logs",
  {
    create: createDutyLogSchema,
    update: updateDutyLogSchema,
  },
  { filterableFields: ["load_id"] },
);

export const GET = routes.list;
export const POST = routes.create;
