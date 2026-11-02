import { createCrudRoutes } from "@/services/api/crud-routes";
import { createDutyLogSchema, updateDutyLogSchema } from "@/data/schemas/duty-logs";
import type { DutyLog } from "@/types/entities";

const routes = createCrudRoutes<DutyLog>("duty_logs", {
  create: createDutyLogSchema,
  update: updateDutyLogSchema,
});

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
