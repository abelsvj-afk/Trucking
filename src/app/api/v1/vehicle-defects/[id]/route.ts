import { createCrudRoutes } from "@/services/api/crud-routes";
import {
  createVehicleDefectSchema,
  updateVehicleDefectSchema,
} from "@/data/schemas/vehicle-defects";
import type { VehicleDefect } from "@/types/entities";

const routes = createCrudRoutes<VehicleDefect>(
  "vehicle_defects",
  { create: createVehicleDefectSchema, update: updateVehicleDefectSchema },
  { filterableFields: ["truck_id", "trailer_id", "status"] },
);

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
