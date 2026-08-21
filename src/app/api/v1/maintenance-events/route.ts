import { createCrudRoutes } from "@/services/api/crud-routes";
import {
  createMaintenanceEventSchema,
  updateMaintenanceEventSchema,
} from "@/data/schemas/maintenance-events";
import type { MaintenanceEvent } from "@/types/entities";

const routes = createCrudRoutes<MaintenanceEvent>(
  "maintenance_events",
  { create: createMaintenanceEventSchema, update: updateMaintenanceEventSchema },
  { filterableFields: ["truck_id"] },
);

export const GET = routes.list;
export const POST = routes.create;
